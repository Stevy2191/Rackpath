import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import ReactFlow, {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  getNodesBounds,
  getViewportForBounds,
  ReactFlowProvider,
  useReactFlow,
  useUpdateNodeInternals,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { toPng, toSvg } from 'html-to-image';
import jsPDF from 'jspdf';
import client from '../api/client';
import { useProject } from '../project/ProjectContext';
import DeviceNode from '../components/DeviceNode';
import ZoneNode from '../components/topology/ZoneNode';
import ShapeNode from '../components/topology/ShapeNode';
import TextLabelNode from '../components/topology/TextLabelNode';
import ConnectionEdge from '../components/topology/ConnectionEdge';
import DevicePicker, {
  MANUAL_DRAG_TYPE,
  DISCOVERED_DRAG_TYPE,
} from '../components/topology/DevicePicker';
import NodePropertiesPanel from '../components/topology/NodePropertiesPanel';
import EdgePropertiesPanel from '../components/topology/EdgePropertiesPanel';
import LinkConfigModal from '../components/topology/LinkConfigModal';
import AddNodeModal from '../components/topology/AddNodeModal';
import TopologyToolbar from '../components/topology/TopologyToolbar';
import TopologySwitcher from '../components/topology/TopologySwitcher';
import TopologyModal from '../components/topology/TopologyModal';
import { getLayoutedElements } from '../utils/layout';
import './Topology.css';

const nodeTypes = { device: DeviceNode, zone: ZoneNode, shape: ShapeNode, text: TextLabelNode };
const edgeTypes = { connection: ConnectionEdge };

function buildDeviceNode(node, callbacks) {
  const linked = node.device_id != null;
  return {
    id: `device-${node.id}`,
    type: 'device',
    position: { x: node.x || 0, y: node.y || 0 },
    style: { width: node.width || 120, height: node.height || 80 },
    data: {
      id: node.id,
      deviceId: node.device_id || null,
      hostname: linked ? node.hostname : node.label,
      ip: linked ? node.ip : null,
      mac: linked ? node.mac : null,
      type: linked ? node.device_type : node.node_type,
      snmp_community: linked ? node.snmp_community : null,
      notes: linked ? node.notes : null,
      icon_color: linked ? node.device_icon_color : node.node_icon_color,
      text_color: linked ? node.device_text_color : node.node_text_color,
      updated_at: node.updated_at,
      onResizeEnd: callbacks?.onDeviceResizeEnd,
    },
  };
}

function buildZoneNode(zone, callbacks, vlans) {
  return {
    id: `zone-${zone.id}`,
    type: 'zone',
    position: { x: zone.x, y: zone.y },
    style: { width: zone.width, height: zone.height },
    data: {
      id: zone.id,
      name: zone.name,
      border_style: zone.border_style,
      color: zone.color,
      vlan_id: zone.vlan_id,
      vlans: vlans || [],
      onResizeEnd: callbacks.onZoneResizeEnd,
      onDelete: callbacks.onZoneDelete,
      onUpdate: callbacks.onZoneUpdate,
    },
  };
}

function buildShapeNode(shape, callbacks) {
  return {
    id: `shape-${shape.id}`,
    type: 'shape',
    position: { x: shape.x, y: shape.y },
    style: { width: shape.width, height: shape.height },
    data: {
      id: shape.id,
      shape_type: shape.shape_type || 'rect',
      fill_color: shape.fill_color,
      border_color: shape.border_color,
      label: shape.label || null,
      onResizeEnd: callbacks.onShapeResizeEnd,
      onDelete: callbacks.onShapeDelete,
      onUpdate: callbacks.onShapeUpdate,
    },
  };
}

function buildTextNode(label, callbacks) {
  return {
    id: `label-${label.id}`,
    type: 'text',
    position: { x: label.x, y: label.y },
    data: {
      id: label.id,
      text: label.text,
      font_size: label.font_size,
      color: label.color,
      onChange: callbacks.onLabelChange,
      onDelete: callbacks.onLabelDelete,
    },
  };
}

function edgeLabelText(edge) {
  return edge.label || undefined;
}

// Stroke dash pattern for an edge's line style. Both "dashed" and "animated"
// use the same dash pattern; "animated" additionally flows the dashes along
// the line via the connection-edge-flow keyframe animation below.
function edgeDashArray(lineStyle) {
  if (lineStyle === 'dashed' || lineStyle === 'animated') return '8 4';
  return undefined;
}

function buildEdge(edge, showLabels, callbacks) {
  const lineStyle = edge.line_style || 'solid';
  const srcType = edge.source_element_type || 'node';
  const tgtType = edge.target_element_type || 'node';
  const srcPrefix = srcType === 'node' ? 'device' : srcType;
  const tgtPrefix = tgtType === 'node' ? 'device' : tgtType;
  return {
    id: `edge-${edge.id}`,
    source: `${srcPrefix}-${edge.source_node_id}`,
    target: `${tgtPrefix}-${edge.target_node_id}`,
    sourceHandle: edge.source_handle || null,
    targetHandle: edge.target_handle || null,
    type: 'connection',
    label: showLabels ? edgeLabelText(edge) : undefined,
    style: {
      stroke: edge.label_color || undefined,
      strokeDasharray: edgeDashArray(lineStyle),
      animation: lineStyle === 'animated' ? 'connection-edge-flow 1s linear infinite' : undefined,
    },
    data: {
      ...edge,
      onEdit: callbacks?.onEdgeEdit,
      onDelete: callbacks?.onEdgeDelete,
      onReroute: callbacks?.onEdgeReroute,
      onUpdate: callbacks?.onEdgeUpdate,
    },
  };
}

function nodeIdFromNodeId(nodeId) {
  return Number(nodeId.replace('device-', ''));
}

function zoneIdFromNodeId(nodeId) {
  return Number(nodeId.replace('zone-', ''));
}

function labelIdFromNodeId(nodeId) {
  return Number(nodeId.replace('label-', ''));
}

function shapeIdFromNodeId(nodeId) {
  return Number(nodeId.replace('shape-', ''));
}

// Strip the type prefix from any canvas-node ReactFlow ID to get the DB row id.
function elementIdFromNodeId(nodeId) {
  return Number(nodeId.replace(/^[^-]+-/, ''));
}

// Map a ReactFlow node ID prefix to the element type stored in topology_edges.
function elementTypeFromNodeId(nodeId) {
  if (nodeId.startsWith('shape-')) return 'shape';
  if (nodeId.startsWith('zone-')) return 'zone';
  if (nodeId.startsWith('label-')) return 'label';
  return 'node';
}

// Best display label for any canvas element (device node, shape, zone, label).
function nodeDisplayLabel(node) {
  if (!node) return 'Unknown';
  const d = node.data;
  return d.hostname || d.name || d.text || d.label || node.type;
}

// Pick which side of each node an auto-drawn connection should attach to,
// based on the relative positions of the two nodes' centres.
function nodeCenter(node) {
  const w = node.style?.width || node.width || 120;
  const h = node.style?.height || node.height || 80;
  return { x: node.position.x + w / 2, y: node.position.y + h / 2 };
}

function computeHandles(source, target) {
  const s = nodeCenter(source);
  const t = nodeCenter(target);
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: 'right', targetHandle: 'left' }
      : { sourceHandle: 'left', targetHandle: 'right' };
  }
  return dy >= 0
    ? { sourceHandle: 'bottom', targetHandle: 'top' }
    : { sourceHandle: 'top', targetHandle: 'bottom' };
}

function TopologyCanvas() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { currentProjectId } = useProject();
  const reactFlowInstance = useReactFlow();
  const reactFlowInstanceRef = useRef(reactFlowInstance);
  reactFlowInstanceRef.current = reactFlowInstance;
  const updateNodeInternals = useUpdateNodeInternals();
  const reactFlowWrapper = useRef(null);

  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [vlans, setVlans] = useState([]);
  const [unplacedDevices, setUnplacedDevices] = useState([]);
  const [connectionPointsByDevice, setConnectionPointsByDevice] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const edgeStyleClipboardRef = useRef(null);
  const [showEdgeLabels, setShowEdgeLabels] = useState(true);
  const [pendingConnection, setPendingConnection] = useState(null);
  const [pendingNode, setPendingNode] = useState(null);
  const [editingEdge, setEditingEdge] = useState(null);
  const [showSavedToast, setShowSavedToast] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Multi-topology state
  const [topologies, setTopologies] = useState([]);
  const [activeTopologyId, setActiveTopologyId] = useState(null);
  const [topologyModalOpen, setTopologyModalOpen] = useState(false);
  const [editingTopology, setEditingTopology] = useState(null);
  const [locations, setLocations] = useState([]);

  // Toolbar state.
  const [mode, setMode] = useState('select');
  const [linkSourceId, setLinkSourceId] = useState(null);
  const [background, setBackground] = useState('dots');
  const [backgroundMenuOpen, setBackgroundMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [shapeType, setShapeType] = useState('rect');
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);

  const handleDeviceResizeEnd = useCallback(
    (nodeId, params) => {
      const id = nodeIdFromNodeId(nodeId);
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                position: { x: params.x, y: params.y },
                style: { ...n.style, width: params.width, height: params.height },
              }
            : n
        )
      );
      updateNodeInternals(nodeId);
      client
        .patch('/topology/layout', {
          positions: [
            { node_id: id, x: params.x, y: params.y, width: params.width, height: params.height },
          ],
        })
        .catch((err) => setError(err.message));
    },
    [updateNodeInternals]
  );

  const handleEdgeEdit = useCallback(
    (edgeId) => {
      const edge = reactFlowInstanceRef.current.getEdge(edgeId);
      if (edge) setEditingEdge(edge);
    },
    [] // stable — reads instance via ref
  );

  const handleEdgeDelete = useCallback(
    (edgeId) => {
      reactFlowInstanceRef.current.deleteElements({ edges: [{ id: edgeId }] });
    },
    [] // stable
  );

  const handleEdgeReroute = useCallback((edgeId, point) => {
    const edgeDbId = Number(edgeId.replace('edge-', ''));
    const waypoint_x = point ? point.x : null;
    const waypoint_y = point ? point.y : null;
    setEdges((eds) =>
      eds.map((e) => (e.id === edgeId ? { ...e, data: { ...e.data, waypoint_x, waypoint_y } } : e))
    );
    client
      .patch(`/topology/edges/${edgeDbId}`, { waypoint_x, waypoint_y })
      .catch((err) => setError(err.message));
  }, []);

  const handleZoneResizeEnd = useCallback((nodeId, params) => {
    const zoneId = zoneIdFromNodeId(nodeId);
    setNodes((nds) =>
      nds.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              position: { x: params.x, y: params.y },
              style: { ...n.style, width: params.width, height: params.height },
            }
          : n
      )
    );
    client
      .patch(`/topology/zones/${zoneId}`, {
        x: params.x,
        y: params.y,
        width: params.width,
        height: params.height,
      })
      .catch((err) => setError(err.message));
  }, []);

  const handleZoneDelete = useCallback(
    (nodeId) => {
      reactFlowInstanceRef.current.deleteElements({ nodes: [{ id: nodeId }] });
    },
    [] // stable
  );

  const handleZoneUpdate = useCallback((nodeId, patch) => {
    const zoneId = zoneIdFromNodeId(nodeId);
    setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)));
    client.patch(`/topology/zones/${zoneId}`, patch).catch((err) => setError(err.message));
  }, []);

  const handleLabelChange = useCallback((nodeId, text) => {
    const labelId = labelIdFromNodeId(nodeId);
    setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, text } } : n)));
    client.patch(`/topology/labels/${labelId}`, { text }).catch((err) => setError(err.message));
  }, []);

  const handleLabelDelete = useCallback(
    (nodeId) => {
      reactFlowInstanceRef.current.deleteElements({ nodes: [{ id: nodeId }] });
    },
    [] // stable
  );

  const handleShapeResizeEnd = useCallback((nodeId, params) => {
    const shapeId = shapeIdFromNodeId(nodeId);
    setNodes((nds) =>
      nds.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              position: { x: params.x, y: params.y },
              style: { ...n.style, width: params.width, height: params.height },
            }
          : n
      )
    );
    client
      .patch(`/topology/shapes/${shapeId}`, { x: params.x, y: params.y, width: params.width, height: params.height })
      .catch((err) => setError(err.message));
  }, []);

  const handleShapeDelete = useCallback(
    (nodeId) => {
      reactFlowInstanceRef.current.deleteElements({ nodes: [{ id: nodeId }] });
    },
    [] // stable
  );

  const handleShapeUpdate = useCallback((nodeId, patch) => {
    const shapeId = shapeIdFromNodeId(nodeId);
    setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)));
    client.patch(`/topology/shapes/${shapeId}`, patch).catch((err) => setError(err.message));
  }, []);

  // Load topologies; auto-select master topology
  useEffect(() => {
    if (!currentProjectId) return;
    client
      .get(`/projects/${currentProjectId}/topologies`)
      .then((res) => {
        setTopologies(res.data || []);
        const master = (res.data || []).find((t) => t.is_master) || (res.data || [])[0];
        if (master) setActiveTopologyId(master.id);
        else setLoading(false);
      })
      .catch((err) => { setError(err.message); setLoading(false); });
  }, [currentProjectId]);

  // Load locations for the topology modal
  useEffect(() => {
    if (!currentProjectId) return;
    client
      .get(`/projects/${currentProjectId}/locations`)
      .then((res) => setLocations(res.data || []))
      .catch(() => {});
  }, [currentProjectId]);

  const handleCreateTopology = useCallback(async (data) => {
    const res = await client.post(`/projects/${currentProjectId}/topologies`, data);
    setTopologies((prev) => [...prev, res.data]);
    setActiveTopologyId(res.data.id);
  }, [currentProjectId]);

  const handleSaveTopology = useCallback(async (data) => {
    if (editingTopology) {
      const res = await client.put(`/topologies/${editingTopology.id}`, data);
      setTopologies((prev) => prev.map((t) => (t.id === editingTopology.id ? res.data : t)));
    } else {
      await handleCreateTopology(data);
    }
  }, [editingTopology, handleCreateTopology]);

  const handleDeleteTopology = useCallback(async (topo) => {
    const confirmed = window.confirm(`Delete "${topo.name}"? All canvas data in this topology will be permanently removed.`);
    if (!confirmed) return;
    await client.delete(`/topologies/${topo.id}`);
    setTopologies((prev) => {
      const next = prev.filter((t) => t.id !== topo.id);
      if (activeTopologyId === topo.id) {
        const master = next.find((t) => t.is_master) || next[0];
        setActiveTopologyId(master?.id ?? null);
      }
      return next;
    });
  }, [activeTopologyId]);

  const handleSwitchTopology = useCallback((id) => {
    setActiveTopologyId(id);
  }, []);

  useEffect(() => {
    if (activeTopologyId === null) return;

    let cancelled = false;

    async function load() {
      const topoParams = { topologyId: activeTopologyId };
      try {
        const [topoRes, edgesRes, zonesRes, shapesRes, labelsRes, pointsRes, unplacedRes, vlansRes] = await Promise.all([
          client.get('/topology', { params: topoParams }),
          client.get('/topology/edges', { params: topoParams }),
          client.get('/topology/zones', { params: topoParams }),
          client.get('/topology/shapes', { params: topoParams }),
          client.get('/topology/labels', { params: topoParams }),
          client.get('/topology/connection-points'),
          client.get('/devices', { params: { unplaced: true } }),
          client.get(`/projects/${currentProjectId || 1}/vlans`),
        ]);
        if (cancelled) return;

        const projectVlans = vlansRes.data || [];
        setVlans(projectVlans);

        const deviceNodes = (topoRes.data.nodes || []).map((device) =>
          buildDeviceNode(device, { onDeviceResizeEnd: handleDeviceResizeEnd })
        );
        const zoneNodes = (zonesRes.data || []).map((zone) =>
          buildZoneNode(
            zone,
            { onZoneResizeEnd: handleZoneResizeEnd, onZoneDelete: handleZoneDelete, onZoneUpdate: handleZoneUpdate },
            projectVlans
          )
        );
        const shapeNodes = (shapesRes.data || []).map((shape) =>
          buildShapeNode(shape, {
            onShapeResizeEnd: handleShapeResizeEnd,
            onShapeDelete: handleShapeDelete,
            onShapeUpdate: handleShapeUpdate,
          })
        );
        const labelNodes = (labelsRes.data || []).map((label) =>
          buildTextNode(label, { onLabelChange: handleLabelChange, onLabelDelete: handleLabelDelete })
        );

        const cpByDevice = {};
        (pointsRes.data || []).forEach((p) => {
          (cpByDevice[p.device_id] = cpByDevice[p.device_id] || []).push(p);
        });
        setConnectionPointsByDevice(cpByDevice);

        setNodes([...zoneNodes, ...shapeNodes, ...deviceNodes, ...labelNodes]);
        setEdges(
          (edgesRes.data || []).map((edge) =>
            buildEdge(edge, true, {
              onEdgeEdit: handleEdgeEdit,
              onEdgeDelete: handleEdgeDelete,
              onEdgeReroute: handleEdgeReroute,
            })
          )
        );
        setUnplacedDevices(unplacedRes.data || []);
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [
    currentProjectId,
    activeTopologyId,
    handleZoneResizeEnd,
    handleZoneDelete,
    handleZoneUpdate,
    handleShapeResizeEnd,
    handleShapeDelete,
    handleShapeUpdate,
    handleDeviceResizeEnd,
    handleEdgeEdit,
    handleEdgeDelete,
    handleEdgeReroute,
    handleLabelChange,
    handleLabelDelete,
  ]);

  // Cross-link from the Rack Builder: ?focusDevice=<id> selects and centers
  // the matching device node once it's loaded, then clears the param so it
  // doesn't re-trigger on subsequent renders.
  useEffect(() => {
    if (loading) return;
    const focusDeviceId = searchParams.get('focusDevice');
    if (!focusDeviceId) return;
    const node = nodes.find((n) => n.type === 'device' && String(n.data.deviceId) === focusDeviceId);
    if (node) {
      setSelectedNodeId(node.id);
      setSelectedEdgeId(null);
      const width = node.style?.width || 120;
      const height = node.style?.height || 80;
      reactFlowInstance.setCenter(node.position.x + width / 2, node.position.y + height / 2, {
        zoom: 1,
        duration: 400,
      });
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('focusDevice');
        return next;
      },
      { replace: true }
    );
  }, [loading, nodes, searchParams, setSearchParams, reactFlowInstance]);

  // Persist a patch to an edge's link-properties-panel settings and update
  // the canvas in place (recomputes label/line-style/animation from the
  // merged data, same as the edit-connection submit handler).
  // Defined before edgeCallbacks to avoid a circular dependency; rebuilds
  // the edge with an inline callbacks object that includes a self-reference.
  // eslint-disable-next-line no-use-before-define
  const handleUpdateEdge = useCallback(
    (edgeDbId, patch) => {
      setEdges((eds) =>
        eds.map((e) =>
          e.id === `edge-${edgeDbId}`
            ? buildEdge({ ...e.data, ...patch }, showEdgeLabels, {
                onEdgeEdit: handleEdgeEdit,
                onEdgeDelete: handleEdgeDelete,
                onEdgeReroute: handleEdgeReroute,
                // eslint-disable-next-line no-use-before-define
                onEdgeUpdate: handleUpdateEdge,
              })
            : e
        )
      );
      client.patch(`/topology/edges/${edgeDbId}`, patch).catch((err) => setError(err.message));
    },
    [showEdgeLabels, handleEdgeEdit, handleEdgeDelete, handleEdgeReroute] // handleUpdateEdge omitted — self-ref
  );

  const edgeCallbacks = useMemo(
    () => ({ onEdgeEdit: handleEdgeEdit, onEdgeDelete: handleEdgeDelete, onEdgeReroute: handleEdgeReroute, onEdgeUpdate: handleUpdateEdge }),
    [handleEdgeEdit, handleEdgeDelete, handleEdgeReroute, handleUpdateEdge]
  );

  const onNodesChange = useCallback(
    (changes) => {
      changes.forEach((change) => {
        if (change.type !== 'remove') return;

        if (change.id.startsWith('device-')) {
          const id = nodeIdFromNodeId(change.id);
          const node = nodes.find((n) => n.id === change.id);
          client.delete(`/topology/nodes/${id}`).catch((err) => setError(err.message));
          if (node && node.data.deviceId) {
            const { onResizeEnd, id: _nodeId, deviceId, ...deviceData } = node.data;
            setUnplacedDevices((devs) => [...devs, { ...deviceData, id: deviceId }]);
          }
        } else if (change.id.startsWith('zone-')) {
          const zoneId = zoneIdFromNodeId(change.id);
          client.delete(`/topology/zones/${zoneId}`).catch((err) => setError(err.message));
          setEdges((eds) => eds.filter((e) => e.source !== change.id && e.target !== change.id));
        } else if (change.id.startsWith('label-')) {
          const labelId = labelIdFromNodeId(change.id);
          client.delete(`/topology/labels/${labelId}`).catch((err) => setError(err.message));
          setEdges((eds) => eds.filter((e) => e.source !== change.id && e.target !== change.id));
        } else if (change.id.startsWith('shape-')) {
          const shapeId = shapeIdFromNodeId(change.id);
          client.delete(`/topology/shapes/${shapeId}`).catch((err) => setError(err.message));
          setEdges((eds) => eds.filter((e) => e.source !== change.id && e.target !== change.id));
        }
      });

      setNodes((nds) => applyNodeChanges(changes, nds));
    },
    [nodes]
  );

  const onEdgesChange = useCallback(
    (changes) => {
      const touchedNodeIds = new Set();

      changes.forEach((change) => {
        if (change.type === 'remove') {
          const edgeId = Number(change.id.replace('edge-', ''));
          client.delete(`/topology/edges/${edgeId}`).catch((err) => setError(err.message));

          const removed = reactFlowInstance.getEdge(change.id);
          if (removed) {
            touchedNodeIds.add(removed.source);
            touchedNodeIds.add(removed.target);
          }
        }
      });

      setEdges((eds) => applyEdgeChanges(changes, eds));
      touchedNodeIds.forEach((nodeId) => updateNodeInternals(nodeId));
    },
    [reactFlowInstance, updateNodeInternals]
  );

  // Open the Link Configuration modal for a source/target pair, computing the
  // attachment handles from geometry when they weren't supplied.
  const openLinkModal = useCallback(
    (sourceNodeId, targetNodeId, sourceHandle, targetHandle) => {
      if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) return;
      const sourceNode = reactFlowInstance.getNode(sourceNodeId);
      const targetNode = reactFlowInstance.getNode(targetNodeId);
      if (!sourceNode || !targetNode) return;

      let handles = { sourceHandle: sourceHandle ?? null, targetHandle: targetHandle ?? null };
      if (!handles.sourceHandle && !handles.targetHandle) {
        handles = computeHandles(sourceNode, targetNode);
      }

      setPendingConnection({
        source: sourceNodeId,
        target: targetNodeId,
        sourceHandle: handles.sourceHandle,
        targetHandle: handles.targetHandle,
        sourceDevice: { id: sourceNode.data.deviceId, hostname: nodeDisplayLabel(sourceNode) },
        targetDevice: { id: targetNode.data.deviceId, hostname: nodeDisplayLabel(targetNode) },
      });
    },
    [reactFlowInstance]
  );

  const onConnect = useCallback(
    (params) => {
      openLinkModal(params.source, params.target, params.sourceHandle, params.targetHandle);
    },
    [openLinkModal]
  );

  const handleConnectionSubmit = useCallback(
    async (formValues) => {
      if (!pendingConnection) return;
      try {
        const res = await client.post('/topology/edges', {
          source_node_id: elementIdFromNodeId(pendingConnection.source),
          target_node_id: elementIdFromNodeId(pendingConnection.target),
          source_element_type: elementTypeFromNodeId(pendingConnection.source),
          target_element_type: elementTypeFromNodeId(pendingConnection.target),
          source_handle: pendingConnection.sourceHandle,
          target_handle: pendingConnection.targetHandle,
          topology_id: activeTopologyId,
          ...formValues,
        });
        setEdges((eds) => addEdge(buildEdge(res.data, showEdgeLabels, edgeCallbacks), eds));
      } catch (err) {
        setError(err.message);
      } finally {
        setPendingConnection(null);
        setMode('select');
      }
    },
    [pendingConnection, showEdgeLabels, edgeCallbacks, activeTopologyId]
  );

  const handleEditConnectionSubmit = useCallback(
    async (formValues) => {
      if (!editingEdge) return;
      const edgeDbId = Number(editingEdge.id.replace('edge-', ''));
      try {
        const res = await client.patch(`/topology/edges/${edgeDbId}`, formValues);
        setEdges((eds) =>
          eds.map((e) => (e.id === editingEdge.id ? buildEdge(res.data, showEdgeLabels, edgeCallbacks) : e))
        );
      } catch (err) {
        setError(err.message);
      } finally {
        setEditingEdge(null);
      }
    },
    [editingEdge, showEdgeLabels, edgeCallbacks]
  );


  // "Copy"/"Paste" on the link properties panel transfers style settings
  // (type, label visibility/color, line style, snapping) from one edge to
  // another via an in-memory clipboard.
  const handleCopyEdgeStyle = useCallback((edge) => {
    const data = edge.data || {};
    edgeStyleClipboardRef.current = {
      cable_type: data.cable_type,
      source_label_visible: data.source_label_visible,
      target_label_visible: data.target_label_visible,
      label_color: data.label_color,
      line_style: data.line_style,
      snapping: data.snapping,
    };
  }, []);

  const handlePasteEdgeStyle = useCallback(
    (edgeDbId) => {
      if (!edgeStyleClipboardRef.current) return;
      handleUpdateEdge(edgeDbId, edgeStyleClipboardRef.current);
    },
    [handleUpdateEdge]
  );

  const onEdgeClick = useCallback((_event, edge) => {
    setSelectedEdgeId(edge.id);
    setSelectedNodeId(null);
  }, []);

  const onEdgeUpdate = useCallback(
    (oldEdge, newConnection) => {
      const edgeDbId = Number(oldEdge.id.replace('edge-', ''));
      client
        .patch(`/topology/edges/${edgeDbId}`, {
          source_node_id: nodeIdFromNodeId(newConnection.source),
          target_node_id: nodeIdFromNodeId(newConnection.target),
          source_handle: newConnection.sourceHandle ?? null,
          target_handle: newConnection.targetHandle ?? null,
        })
        .then((res) => {
          setEdges((eds) =>
            eds.map((e) => (e.id === oldEdge.id ? buildEdge(res.data, showEdgeLabels, edgeCallbacks) : e))
          );
        })
        .catch((err) => setError(err.message));
    },
    [showEdgeLabels, edgeCallbacks]
  );

  const toggleEdgeLabels = useCallback(() => {
    setShowEdgeLabels((prev) => {
      const next = !prev;
      setEdges((eds) => eds.map((e) => ({ ...e, label: next ? edgeLabelText(e.data) : undefined })));
      return next;
    });
  }, []);

  const saveNodePosition = useCallback((node) => {
    if (node.type === 'device') {
      return client.patch('/topology/layout', {
        positions: [{ node_id: nodeIdFromNodeId(node.id), x: node.position.x, y: node.position.y }],
      });
    } else if (node.type === 'zone') {
      return client.patch(`/topology/zones/${zoneIdFromNodeId(node.id)}`, { x: node.position.x, y: node.position.y });
    } else if (node.type === 'text') {
      return client.patch(`/topology/labels/${labelIdFromNodeId(node.id)}`, { x: node.position.x, y: node.position.y });
    } else if (node.type === 'shape') {
      return client.patch(`/topology/shapes/${shapeIdFromNodeId(node.id)}`, { x: node.position.x, y: node.position.y });
    }
    return Promise.resolve();
  }, []);

  const onNodeDragStop = useCallback((_event, node) => {
    saveNodePosition(node).catch((err) => setError(err.message));
  }, [saveNodePosition]);

  const onSelectionDragStop = useCallback((_event, _node, selectedNodes) => {
    Promise.all(selectedNodes.map((n) => saveNodePosition(n)))
      .catch((err) => setError(err.message));
  }, [saveNodePosition]);

  const onNodeClick = useCallback(
    (_event, node) => {
      if (mode === 'link') {
        if (!linkSourceId) {
          setLinkSourceId(node.id);
        } else if (linkSourceId !== node.id) {
          openLinkModal(linkSourceId, node.id);
          setLinkSourceId(null);
        } else {
          setLinkSourceId(null);
        }
        return;
      }
      if (mode === 'select') {
        if (node.type === 'device') {
          setSelectedNodeId(node.id);
          setSelectedEdgeId(null);
        }
      }
    },
    [mode, linkSourceId, openLinkModal]
  );

  const onNodeDoubleClick = useCallback(
    (_event, node) => {
      // Double-click edits an element regardless of the active mode. Text and
      // zone nodes handle their own inline editors; a device node opens the
      // linked device's page (standalone nodes have nothing to navigate to).
      if (node.type === 'device' && node.data.deviceId) navigate(`/devices/${node.data.deviceId}`);
    },
    [navigate]
  );

  const projectFromEvent = useCallback(
    (event) => {
      const bounds = reactFlowWrapper.current.getBoundingClientRect();
      return reactFlowInstance.project({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    },
    [reactFlowInstance]
  );

  const addLabelAt = useCallback(
    async (position) => {
      try {
        const res = await client.post('/topology/labels', {
          text: '',
          x: position.x,
          y: position.y,
          font_size: 14,
          topology_id: activeTopologyId,
        });
        setNodes((nds) => [
          ...nds,
          buildTextNode(res.data, { onLabelChange: handleLabelChange, onLabelDelete: handleLabelDelete }),
        ]);
        setMode('select');
      } catch (err) {
        setError(err.message);
      }
    },
    [handleLabelChange, handleLabelDelete, activeTopologyId]
  );

  const addZoneAt = useCallback(
    async (position) => {
      try {
        const res = await client.post('/topology/zones', {
          name: 'Zone',
          border_style: 'solid',
          color: 'blue',
          x: position.x,
          y: position.y,
          width: 320,
          height: 220,
          topology_id: activeTopologyId,
        });
        setNodes((nds) => [
          buildZoneNode(
            res.data,
            { onZoneResizeEnd: handleZoneResizeEnd, onZoneDelete: handleZoneDelete, onZoneUpdate: handleZoneUpdate },
            vlans
          ),
          ...nds,
        ]);
        setMode('select');
      } catch (err) {
        setError(err.message);
      }
    },
    [handleZoneResizeEnd, handleZoneDelete, handleZoneUpdate, vlans, activeTopologyId]
  );

  const addShapeAt = useCallback(
    async (position, type) => {
      try {
        const res = await client.post('/topology/shapes', {
          shape_type: type || 'rect',
          x: position.x,
          y: position.y,
          width: 160,
          height: 100,
          topology_id: activeTopologyId,
        });
        setNodes((nds) => [
          ...nds,
          buildShapeNode(res.data, {
            onShapeResizeEnd: handleShapeResizeEnd,
            onShapeDelete: handleShapeDelete,
            onShapeUpdate: handleShapeUpdate,
          }),
        ]);
        setMode('select');
      } catch (err) {
        setError(err.message);
      }
    },
    [handleShapeResizeEnd, handleShapeDelete, handleShapeUpdate, activeTopologyId]
  );

  const onPaneClick = useCallback(
    (event) => {
      setExportMenuOpen(false);
      setBackgroundMenuOpen(false);
      setShapeMenuOpen(false);
      setLinkSourceId(null);

      if (mode === 'text') {
        addLabelAt(projectFromEvent(event));
        return;
      }
      if (mode === 'zone') {
        addZoneAt(projectFromEvent(event));
        return;
      }
      if (mode === 'shape') {
        addShapeAt(projectFromEvent(event), shapeType);
        return;
      }
      if (mode === 'link') setMode('select');
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
    },
    [mode, shapeType, addLabelAt, addZoneAt, addShapeAt, projectFromEvent]
  );

  const handleModeChange = useCallback((next) => {
    setMode(next);
    setLinkSourceId(null);
    setBackgroundMenuOpen(false);
    setShapeMenuOpen(false);
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape' && mode !== 'select') handleModeChange('select');
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mode, handleModeChange]);

  const handleConnectionPointsChange = useCallback((deviceId, points) => {
    setConnectionPointsByDevice((prev) => ({ ...prev, [deviceId]: points }));
  }, []);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || null;
  const selectedEdge = edges.find((e) => e.id === selectedEdgeId) || null;
  const selectedEdgeSourceNode = selectedEdge ? nodes.find((n) => n.id === selectedEdge.source) : null;
  const selectedEdgeTargetNode = selectedEdge ? nodes.find((n) => n.id === selectedEdge.target) : null;

  const handleRemoveSelected = useCallback(() => {
    if (!selectedNodeId) return;
    reactFlowInstance.deleteElements({ nodes: [{ id: selectedNodeId }] });
    setSelectedNodeId(null);
  }, [selectedNodeId, reactFlowInstance]);

  const handleDeleteSelectedEdge = useCallback(
    (edgeId) => {
      reactFlowInstance.deleteElements({ edges: [{ id: edgeId }] });
      setSelectedEdgeId(null);
    },
    [reactFlowInstance]
  );

  const handleUpdateDevice = useCallback((deviceId, patch) => {
    setNodes((nds) =>
      nds.map((n) => (n.data.deviceId === deviceId ? { ...n, data: { ...n.data, ...patch } } : n))
    );
    client.patch(`/devices/${deviceId}`, patch).catch((err) => setError(err.message));
  }, []);

  // Updates a standalone node's own label/type/colors (linked nodes are
  // edited via handleUpdateDevice instead, which patches the device record).
  const handleUpdateNode = useCallback((nodeId, patch) => {
    const displayPatch = 'label' in patch ? { ...patch, hostname: patch.label } : patch;
    setNodes((nds) =>
      nds.map((n) => (n.data.id === nodeId ? { ...n, data: { ...n.data, ...displayPatch } } : n))
    );
    client.patch(`/topology/nodes/${nodeId}`, patch).catch((err) => setError(err.message));
  }, []);

  // Copying a node always creates a standalone diagram node from the
  // resolved display values of the source node — it never duplicates a
  // Device Inventory record or its interfaces.
  const handleCopyNode = useCallback(async () => {
    if (!selectedNode) return;
    try {
      const res = await client.post('/topology/nodes', {
        label: selectedNode.data.hostname ? `${selectedNode.data.hostname} (copy)` : null,
        type: selectedNode.data.type,
        icon_color: selectedNode.data.icon_color,
        text_color: selectedNode.data.text_color,
        x: selectedNode.position.x + 40,
        y: selectedNode.position.y + 40,
        topology_id: activeTopologyId,
      });

      const newNode = buildDeviceNode(res.data, { onDeviceResizeEnd: handleDeviceResizeEnd });
      setNodes((nds) => [...nds, newNode]);
      setSelectedNodeId(newNode.id);
    } catch (err) {
      setError(err.message);
    }
  }, [selectedNode, handleDeviceResizeEnd, activeTopologyId]);

  const handleAutoLayout = useCallback(() => {
    const deviceNodes = nodes.filter((n) => n.type === 'device');
    const otherNodes = nodes.filter((n) => n.type !== 'device');
    const { nodes: layouted } = getLayoutedElements(deviceNodes, edges);

    setNodes([...otherNodes, ...layouted]);

    client
      .patch('/topology/layout', {
        positions: layouted.map((n) => ({
          node_id: nodeIdFromNodeId(n.id),
          x: n.position.x,
          y: n.position.y,
        })),
      })
      .catch((err) => setError(err.message));
  }, [nodes, edges]);

  const handleFitView = useCallback(() => {
    reactFlowInstance.fitView({ padding: 0.2 });
  }, [reactFlowInstance]);

  const handleClearCanvas = useCallback(async () => {
    const confirmed = window.confirm(
      'Are you sure you want to clear the canvas? This will delete all nodes, edges, zones, and text labels. This cannot be undone.'
    );
    if (!confirmed) return;

    try {
      await client.delete(`/topology/all${activeTopologyId ? `?topologyId=${activeTopologyId}` : ''}`);
      setUnplacedDevices((devs) => [
        ...devs,
        ...nodes
          .filter((n) => n.type === 'device' && n.data.deviceId)
          .map((n) => {
            const { onResizeEnd, id: _nodeId, deviceId, ...deviceData } = n.data;
            return { ...deviceData, id: deviceId };
          }),
      ]);
      setNodes([]);
      setEdges([]);
      setSelectedNodeId(null);
    } catch (err) {
      setError(err.message);
    }
  }, [nodes, activeTopologyId]);

  const handleSaveAll = useCallback(async () => {
    try {
      const deviceNodes = nodes.filter((n) => n.type === 'device');
      const zoneNodes = nodes.filter((n) => n.type === 'zone');
      const shapeNodes = nodes.filter((n) => n.type === 'shape');

      if (deviceNodes.length > 0) {
        await client.patch('/topology/layout', {
          positions: deviceNodes.map((n) => ({
            node_id: nodeIdFromNodeId(n.id),
            x: n.position.x,
            y: n.position.y,
            width: n.style?.width,
            height: n.style?.height,
          })),
        });
      }

      await Promise.all([
        ...zoneNodes.map((n) =>
          client.patch(`/topology/zones/${zoneIdFromNodeId(n.id)}`, {
            x: n.position.x,
            y: n.position.y,
            width: n.style?.width,
            height: n.style?.height,
          })
        ),
        ...shapeNodes.map((n) =>
          client.patch(`/topology/shapes/${shapeIdFromNodeId(n.id)}`, {
            x: n.position.x,
            y: n.position.y,
            width: n.style?.width,
            height: n.style?.height,
          })
        ),
      ]);

      setShowSavedToast(true);
      setTimeout(() => setShowSavedToast(false), 2000);
    } catch (err) {
      setError(err.message);
    }
  }, [nodes]);

  const handleExport = useCallback(
    async (format) => {
      setExportMenuOpen(false);
      if (!reactFlowWrapper.current) return;

      const viewportEl = reactFlowWrapper.current.querySelector('.react-flow__viewport');
      if (!viewportEl) return;

      setExporting(true);
      try {
        const bounds = getNodesBounds(reactFlowInstance.getNodes());
        const paddingRatio = 0.1;
        const imageWidth = Math.max(Math.ceil(bounds.width * (1 + paddingRatio * 2)), 800);
        const imageHeight = Math.max(Math.ceil(bounds.height * (1 + paddingRatio * 2)), 600);
        const { x, y, zoom } = getViewportForBounds(bounds, imageWidth, imageHeight, 0.5, 2, paddingRatio);

        const captureOptions = {
          backgroundColor:
            getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() || '#ffffff',
          width: imageWidth,
          height: imageHeight,
          style: {
            width: `${imageWidth}px`,
            height: `${imageHeight}px`,
            transform: `translate(${x}px, ${y}px) scale(${zoom})`,
          },
        };

        const downloadDataUrl = (dataUrl, filename) => {
          const link = document.createElement('a');
          link.download = filename;
          link.href = dataUrl;
          link.click();
        };

        if (format === 'svg') {
          const dataUrl = await toSvg(viewportEl, captureOptions);
          downloadDataUrl(dataUrl, 'rackpath-topology.svg');
        } else {
          const dataUrl = await toPng(viewportEl, captureOptions);
          if (format === 'pdf') {
            const orientation = imageWidth >= imageHeight ? 'landscape' : 'portrait';
            const pdf = new jsPDF({ orientation, unit: 'px', format: [imageWidth, imageHeight] });
            pdf.addImage(dataUrl, 'PNG', 0, 0, imageWidth, imageHeight);
            pdf.save('rackpath-topology.pdf');
          } else {
            downloadDataUrl(dataUrl, 'rackpath-topology.png');
          }
        }
      } catch (err) {
        setError(err.message);
      } finally {
        setExporting(false);
      }
    },
    [reactFlowInstance]
  );

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    async (event) => {
      event.preventDefault();
      if (!reactFlowWrapper.current) return;

      const bounds = reactFlowWrapper.current.getBoundingClientRect();
      const position = reactFlowInstance.project({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });

      const manualData = event.dataTransfer.getData(MANUAL_DRAG_TYPE);
      const discoveredId = event.dataTransfer.getData(DISCOVERED_DRAG_TYPE);

      if (manualData) {
        // Dragging a palette card doesn't immediately create a node — open the
        // Add Node modal so the user can choose standalone vs. linked.
        setPendingNode({ position, deviceInfo: JSON.parse(manualData) });
      } else if (discoveredId) {
        const deviceId = Number(discoveredId);
        const device = unplacedDevices.find((d) => d.id === deviceId);
        if (!device) return;

        try {
          const res = await client.post('/topology/nodes', {
            device_id: deviceId,
            x: position.x,
            y: position.y,
            topology_id: activeTopologyId,
          });
          const newNode = buildDeviceNode(res.data, { onDeviceResizeEnd: handleDeviceResizeEnd });
          setNodes((nds) => [...nds, newNode]);
          setUnplacedDevices((devs) => devs.filter((d) => d.id !== deviceId));
          setSelectedNodeId(newNode.id);
        } catch (err) {
          setError(err.message);
        }
      }
    },
    [reactFlowInstance, unplacedDevices, handleDeviceResizeEnd, activeTopologyId]
  );

  const handleAddNodeStandalone = useCallback(async () => {
    if (!pendingNode) return;
    const { position, deviceInfo } = pendingNode;
    try {
      const res = await client.post('/topology/nodes', {
        label: deviceInfo.label,
        type: deviceInfo.type,
        x: position.x,
        y: position.y,
        topology_id: activeTopologyId,
      });
      const newNode = buildDeviceNode(res.data, { onDeviceResizeEnd: handleDeviceResizeEnd });
      setNodes((nds) => [...nds, newNode]);
      setSelectedNodeId(newNode.id);
    } catch (err) {
      setError(err.message);
    } finally {
      setPendingNode(null);
    }
  }, [pendingNode, handleDeviceResizeEnd, activeTopologyId]);

  const handleAddNodeLink = useCallback(
    async (deviceId) => {
      if (!pendingNode) return;
      const { position } = pendingNode;
      try {
        const res = await client.post('/topology/nodes', {
          device_id: deviceId,
          x: position.x,
          y: position.y,
          topology_id: activeTopologyId,
        });
        const newNode = buildDeviceNode(res.data, { onDeviceResizeEnd: handleDeviceResizeEnd });
        setNodes((nds) => [...nds, newNode]);
        setUnplacedDevices((devs) => devs.filter((d) => d.id !== deviceId));
        setSelectedNodeId(newNode.id);
      } catch (err) {
        setError(err.message);
      } finally {
        setPendingNode(null);
      }
    },
    [pendingNode, handleDeviceResizeEnd, activeTopologyId]
  );

  // Inject the current interaction mode and per-node connection points into
  // device nodes so they render the right handles for the active mode.
  const displayNodes = useMemo(
    () =>
      nodes.map((n) => {
        if (n.type === 'device') {
          return {
            ...n,
            data: {
              ...n.data,
              mode,
              isLinkSource: n.id === linkSourceId,
              connectionPoints: connectionPointsByDevice[n.data.deviceId] || [],
            },
          };
        }
        // Pass mode to shape/zone/label so they can show handles in link mode
        if (n.type === 'shape' || n.type === 'zone' || n.type === 'text') {
          return { ...n, data: { ...n.data, mode } };
        }
        return n;
      }),
    [nodes, mode, linkSourceId, connectionPointsByDevice]
  );

  const editSourceNode = editingEdge ? nodes.find((n) => n.id === editingEdge.source) : null;
  const editTargetNode = editingEdge ? nodes.find((n) => n.id === editingEdge.target) : null;

  if (loading) return <div className="page-status">Loading topology...</div>;

  return (
    <div className="topology-page">
      {error && <div className="page-error">{error}</div>}

      <TopologyToolbar
        mode={mode}
        onModeChange={handleModeChange}
        shapeType={shapeType}
        onShapeTypeChange={setShapeType}
        shapeMenuOpen={shapeMenuOpen}
        onToggleShapeMenu={() => setShapeMenuOpen((o) => !o)}
        background={background}
        backgroundMenuOpen={backgroundMenuOpen}
        onToggleBackgroundMenu={() => setBackgroundMenuOpen((o) => !o)}
        onBackgroundChange={(bg) => {
          setBackground(bg);
          setBackgroundMenuOpen(false);
        }}
        showEdgeLabels={showEdgeLabels}
        onToggleEdgeLabels={toggleEdgeLabels}
        onSave={handleSaveAll}
        onExport={handleExport}
        exporting={exporting}
        exportMenuOpen={exportMenuOpen}
        onToggleExportMenu={() => setExportMenuOpen((o) => !o)}
        onClearCanvas={handleClearCanvas}
      />

      {topologies.length > 0 && (
        <div className="topology-switcher-bar">
          <TopologySwitcher
            topologies={topologies}
            activeTopologyId={activeTopologyId}
            onSwitch={handleSwitchTopology}
            onCreate={() => { setEditingTopology(null); setTopologyModalOpen(true); }}
            onEdit={(topo) => { setEditingTopology(topo); setTopologyModalOpen(true); }}
            onDelete={handleDeleteTopology}
          />
        </div>
      )}

      <div className="topology-body">
        <DevicePicker unplacedDevices={unplacedDevices} />

        <div className={`topology-canvas topology-mode-${mode}`} ref={reactFlowWrapper}>
          <ReactFlow
            nodes={displayNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            connectionMode={ConnectionMode.Loose}
            nodesDraggable={mode === 'select'}
            elevateNodesOnSelect={false}
            zoomOnDoubleClick={false}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onEdgeUpdate={onEdgeUpdate}
            onNodeDragStop={onNodeDragStop}
            onSelectionDragStop={onSelectionDragStop}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            onDrop={onDrop}
            onDragOver={onDragOver}
            deleteKeyCode={['Backspace', 'Delete']}
            fitView
          >
            {background === 'dots' && (
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--color-border-strong)" />
            )}
            {background === 'lines' && (
              <Background variant={BackgroundVariant.Lines} gap={24} size={1} color="var(--color-border)" />
            )}
            <Controls />
          </ReactFlow>

          <div className="topology-floating-actions">
            <button type="button" onClick={handleAutoLayout} title="Auto layout">
              Auto Layout
            </button>
            <button type="button" onClick={handleFitView} title="Fit view">
              Fit View
            </button>
          </div>

          <NodePropertiesPanel
            node={selectedNode}
            onClose={() => setSelectedNodeId(null)}
            onUpdateDevice={handleUpdateDevice}
            onUpdateNode={handleUpdateNode}
            onDelete={handleRemoveSelected}
            onCopy={handleCopyNode}
            onConnectionPointsChange={handleConnectionPointsChange}
          />

          <EdgePropertiesPanel
            edge={selectedEdge}
            sourceHostname={
              selectedEdgeSourceNode?.data?.hostname || (selectedEdgeSourceNode ? `Node ${selectedEdgeSourceNode.data.id}` : '')
            }
            targetHostname={
              selectedEdgeTargetNode?.data?.hostname || (selectedEdgeTargetNode ? `Node ${selectedEdgeTargetNode.data.id}` : '')
            }
            onClose={() => setSelectedEdgeId(null)}
            onUpdate={handleUpdateEdge}
            onDelete={handleDeleteSelectedEdge}
            onCopy={handleCopyEdgeStyle}
            onPaste={handlePasteEdgeStyle}
          />

          {showSavedToast && <div className="topology-toast">Saved!</div>}
        </div>
      </div>

      {pendingNode && (
        <AddNodeModal
          deviceInfo={pendingNode.deviceInfo}
          devices={unplacedDevices}
          onConfirmStandalone={handleAddNodeStandalone}
          onConfirmLink={handleAddNodeLink}
          onCancel={() => setPendingNode(null)}
        />
      )}

      {pendingConnection && (
        <LinkConfigModal
          sourceDevice={pendingConnection.sourceDevice}
          targetDevice={pendingConnection.targetDevice}
          onSubmit={handleConnectionSubmit}
          onCancel={() => { setPendingConnection(null); setMode('select'); }}
        />
      )}

      {editingEdge && (
        <LinkConfigModal
          initialValues={editingEdge.data}
          sourceDevice={{ id: editSourceNode?.data.deviceId, hostname: editSourceNode?.data.hostname }}
          targetDevice={{ id: editTargetNode?.data.deviceId, hostname: editTargetNode?.data.hostname }}
          onSubmit={handleEditConnectionSubmit}
          onCancel={() => setEditingEdge(null)}
        />
      )}

      {topologyModalOpen && (
        <TopologyModal
          topology={editingTopology}
          locations={locations}
          onSave={handleSaveTopology}
          onClose={() => { setTopologyModalOpen(false); setEditingTopology(null); }}
        />
      )}
    </div>
  );
}

export default function TopologyPage() {
  return (
    <ReactFlowProvider>
      <TopologyCanvas />
    </ReactFlowProvider>
  );
}
