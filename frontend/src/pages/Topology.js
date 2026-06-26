import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import client from '../api/client';
import { useProject } from '../project/ProjectContext';
import X6Canvas from '../components/topology/X6Canvas';
import DevicePicker from '../components/topology/DevicePicker';
import NodePropertiesPanel from '../components/topology/NodePropertiesPanel';
import EdgePropertiesPanel from '../components/topology/EdgePropertiesPanel';
import LinkConfigModal from '../components/topology/LinkConfigModal';
import AddNodeModal from '../components/topology/AddNodeModal';
import TopologyToolbar from '../components/topology/TopologyToolbar';
import TopologySwitcher from '../components/topology/TopologySwitcher';
import TopologyModal from '../components/topology/TopologyModal';
import { getLayoutedElements } from '../utils/layout';
import './Topology.css';

// ── ID helpers ────────────────────────────────────────────────────────────────
function rfIdToDbId(rfId) {
  return Number(rfId.replace(/^[^-]+-/, ''));
}

function cellTypeFromRfId(rfId) {
  if (rfId.startsWith('shape-')) return 'shape';
  if (rfId.startsWith('zone-'))  return 'zone';
  if (rfId.startsWith('label-')) return 'label';
  return 'node';
}

function rfIdFromElementType(elementType, dbId) {
  const prefix = elementType === 'node' ? 'device'
    : elementType === 'shape' ? 'shape'
    : elementType === 'zone'  ? 'zone'
    : 'label';
  return `${prefix}-${dbId}`;
}

// ── Node-data builders ────────────────────────────────────────────────────────
function buildDeviceNodeData(node) {
  const linked = node.device_id != null;
  return {
    _rfId: `device-${node.id}`,
    _cellType: 'device',
    id: node.id,
    x: node.x || 0,
    y: node.y || 0,
    width: node.width || 120,
    height: node.height || 80,
    deviceId: node.device_id || null,
    hostname: linked ? node.hostname : node.label,
    label: linked ? node.hostname : node.label,
    ip: linked ? node.ip : null,
    mac: linked ? node.mac : null,
    type: linked ? node.device_type : node.node_type,
    snmp_community: linked ? node.snmp_community : null,
    notes: linked ? node.notes : null,
    icon_color: linked ? node.device_icon_color : node.node_icon_color,
    text_color: linked ? node.device_text_color : node.node_text_color,
  };
}

function buildZoneNodeData(zone, vlans) {
  return {
    _rfId: `zone-${zone.id}`,
    _cellType: 'zone',
    id: zone.id,
    x: zone.x,
    y: zone.y,
    width: zone.width,
    height: zone.height,
    name: zone.name,
    border_style: zone.border_style,
    color: zone.color,
    vlan_id: zone.vlan_id,
    vlans: vlans || [],
  };
}

function buildShapeNodeData(shape) {
  return {
    _rfId: `shape-${shape.id}`,
    _cellType: 'shape',
    id: shape.id,
    x: shape.x,
    y: shape.y,
    width: shape.width,
    height: shape.height,
    shape_type: shape.shape_type || 'rect',
    fill_color: shape.fill_color,
    border_color: shape.border_color,
    label: shape.label || null,
  };
}

function buildLabelNodeData(label) {
  return {
    _rfId: `label-${label.id}`,
    _cellType: 'label',
    id: label.id,
    x: label.x,
    y: label.y,
    width: 140,
    height: 30,
    text: label.text,
    font_size: label.font_size,
    color: label.color,
  };
}

// ── Main component ────────────────────────────────────────────────────────────
export default function TopologyPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { currentProjectId } = useProject();
  const canvasRef = useRef(null);

  // ── Data state ────────────────────────────────────────────────────────────
  const [nodesCache, setNodesCache] = useState([]); // raw node data for properties panel
  const [edgesCache, setEdgesCache] = useState([]); // raw edge data
  const [vlans, setVlans] = useState([]);
  const [unplacedDevices, setUnplacedDevices] = useState([]);
  const [, setConnectionPointsByDevice] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // ── Selection state ──────────────────────────────────────────────────────
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);

  // ── UI state ─────────────────────────────────────────────────────────────
  const [showEdgeLabels, setShowEdgeLabels] = useState(true);
  const [pendingConnection, setPendingConnection] = useState(null);
  const [pendingNode, setPendingNode] = useState(null);
  const [editingEdge, setEditingEdge] = useState(null);
  const [showSavedToast, setShowSavedToast] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showMinimap, setShowMinimap] = useState(false);
  const [background, setBackground] = useState('dots');
  const [mode, setMode] = useState('select');
  const [shapeType, setShapeType] = useState('rect');
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
  const [backgroundMenuOpen, setBackgroundMenuOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);

  // ── Multi-topology state ─────────────────────────────────────────────────
  const [topologies, setTopologies] = useState([]);
  const [activeTopologyId, setActiveTopologyId] = useState(null);
  const [topologyModalOpen, setTopologyModalOpen] = useState(false);
  const [editingTopology, setEditingTopology] = useState(null);
  const [locations, setLocations] = useState([]);

  // ── Derived selected items ───────────────────────────────────────────────
  const selectedNode = useMemo(
    () => nodesCache.find((n) => n._rfId === selectedNodeId) || null,
    [nodesCache, selectedNodeId]
  );
  const selectedEdge = useMemo(
    () => edgesCache.find((e) => `edge-${e.id}` === selectedEdgeId) || null,
    [edgesCache, selectedEdgeId]
  );

  // Reconstruct full edge object for EdgePropertiesPanel (it expects RF-style {id, source, target, data})
  const selectedEdgePanelObj = useMemo(() => {
    if (!selectedEdge) return null;
    return {
      id: `edge-${selectedEdge.id}`,
      source: rfIdFromElementType(selectedEdge.source_element_type, selectedEdge.source_node_id),
      target: rfIdFromElementType(selectedEdge.target_element_type, selectedEdge.target_node_id),
      data: selectedEdge,
    };
  }, [selectedEdge]);

  const selectedEdgeSourceNode = useMemo(() => {
    if (!selectedEdge) return null;
    const rfId = rfIdFromElementType(selectedEdge.source_element_type, selectedEdge.source_node_id);
    return nodesCache.find((n) => n._rfId === rfId) || null;
  }, [selectedEdge, nodesCache]);

  const selectedEdgeTargetNode = useMemo(() => {
    if (!selectedEdge) return null;
    const rfId = rfIdFromElementType(selectedEdge.target_element_type, selectedEdge.target_node_id);
    return nodesCache.find((n) => n._rfId === rfId) || null;
  }, [selectedEdge, nodesCache]);

  // ── Topology list load ───────────────────────────────────────────────────
  useEffect(() => {
    if (!currentProjectId) return;
    client.get(`/projects/${currentProjectId}/topologies`)
      .then((res) => {
        setTopologies(res.data || []);
        const master = (res.data || []).find((t) => t.is_master) || (res.data || [])[0];
        if (master) setActiveTopologyId(master.id);
        else setLoading(false);
      })
      .catch((err) => { setError(err.message); setLoading(false); });
  }, [currentProjectId]);

  useEffect(() => {
    if (!currentProjectId) return;
    client.get(`/projects/${currentProjectId}/locations`)
      .then((res) => setLocations(res.data || []))
      .catch(() => {});
  }, [currentProjectId]);

  // ── Canvas data load ─────────────────────────────────────────────────────
  useEffect(() => {
    if (activeTopologyId === null) return;
    let cancelled = false;

    async function load() {
      const tp = { topologyId: activeTopologyId };
      try {
        const [topoRes, edgesRes, zonesRes, shapesRes, labelsRes, pointsRes, unplacedRes, vlansRes] =
          await Promise.all([
            client.get('/topology', { params: tp }),
            client.get('/topology/edges', { params: tp }),
            client.get('/topology/zones', { params: tp }),
            client.get('/topology/shapes', { params: tp }),
            client.get('/topology/labels', { params: tp }),
            client.get('/topology/connection-points'),
            client.get('/devices', { params: { unplaced: true } }),
            client.get(`/projects/${currentProjectId || 1}/vlans`),
          ]);
        if (cancelled) return;

        const projectVlans = vlansRes.data || [];
        setVlans(projectVlans);

        const cpByDevice = {};
        (pointsRes.data || []).forEach((p) => {
          (cpByDevice[p.device_id] = cpByDevice[p.device_id] || []).push(p);
        });
        setConnectionPointsByDevice(cpByDevice);

        const deviceNodes = (topoRes.data.nodes || []).map(buildDeviceNodeData);
        const zoneNodes   = (zonesRes.data  || []).map((z) => buildZoneNodeData(z, projectVlans));
        const shapeNodes  = (shapesRes.data  || []).map(buildShapeNodeData);
        const labelNodes  = (labelsRes.data  || []).map(buildLabelNodeData);
        const allNodes = [...zoneNodes, ...shapeNodes, ...deviceNodes, ...labelNodes];

        setNodesCache(allNodes);
        setEdgesCache(edgesRes.data || []);
        setUnplacedDevices(unplacedRes.data || []);

        // Initialise the X6 graph once we have the canvas ref
        if (canvasRef.current) {
          canvasRef.current.loadGraph(allNodes, edgesRes.data || [], true);
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [currentProjectId, activeTopologyId]);

  // Focus device cross-link from Rack Builder
  useEffect(() => {
    if (loading) return;
    const focusDeviceId = searchParams.get('focusDevice');
    if (!focusDeviceId) return;
    const node = nodesCache.find((n) => n._cellType === 'device' && String(n.deviceId) === focusDeviceId);
    if (node) {
      setSelectedNodeId(node._rfId);
      setSelectedEdgeId(null);
      const g = canvasRef.current?.getGraph();
      if (g) {
        const cell = g.getCellById(node._rfId);
        if (cell) g.centerCell(cell);
      }
    }
    setSearchParams((prev) => { const next = new URLSearchParams(prev); next.delete('focusDevice'); return next; }, { replace: true });
  }, [loading, nodesCache, searchParams, setSearchParams]);

  // ── Canvas event handlers ─────────────────────────────────────────────────
  const handleNodeSelect = useCallback((rfId, data) => {
    setSelectedNodeId(rfId);
    setSelectedEdgeId(null);
  }, []);

  const handleEdgeSelect = useCallback((rfId, data) => {
    setSelectedEdgeId(rfId);
    setSelectedNodeId(null);
  }, []);

  const handleSelectionClear = useCallback(() => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
  }, []);

  const handleNodeDeleted = useCallback((rfId, data) => {
    const cellType = cellTypeFromRfId(rfId);
    const dbId = rfIdToDbId(rfId);
    if (cellType === 'device') {
      client.delete(`/topology/nodes/${dbId}`).catch((err) => setError(err.message));
      const node = nodesCache.find((n) => n._rfId === rfId);
      if (node?.deviceId) {
        const { deviceId, hostname, ip, mac, type } = node;
        setUnplacedDevices((devs) => [...devs, { id: deviceId, hostname, ip, mac, device_type: type }]);
      }
    } else if (cellType === 'zone') {
      client.delete(`/topology/zones/${dbId}`).catch((err) => setError(err.message));
    } else if (cellType === 'label') {
      client.delete(`/topology/labels/${dbId}`).catch((err) => setError(err.message));
    } else if (cellType === 'shape') {
      client.delete(`/topology/shapes/${dbId}`).catch((err) => setError(err.message));
    }
    setNodesCache((prev) => prev.filter((n) => n._rfId !== rfId));
    if (selectedNodeId === rfId) setSelectedNodeId(null);
  }, [nodesCache, selectedNodeId]);

  const handleEdgeDeleted = useCallback((rfId) => {
    const dbId = rfIdToDbId(rfId);
    client.delete(`/topology/edges/${dbId}`).catch((err) => setError(err.message));
    setEdgesCache((prev) => prev.filter((e) => `edge-${e.id}` !== rfId));
    if (selectedEdgeId === rfId) setSelectedEdgeId(null);
  }, [selectedEdgeId]);

  const handleNodeMoved = useCallback((rfId, x, y, width, height) => {
    const cellType = cellTypeFromRfId(rfId);
    const dbId = rfIdToDbId(rfId);
    setNodesCache((prev) => prev.map((n) => n._rfId === rfId ? { ...n, x, y, width, height } : n));
    if (cellType === 'device') {
      client.patch('/topology/layout', { positions: [{ node_id: dbId, x, y, width, height }] })
        .catch((err) => setError(err.message));
    } else if (cellType === 'zone') {
      client.patch(`/topology/zones/${dbId}`, { x, y }).catch((err) => setError(err.message));
    } else if (cellType === 'label') {
      client.patch(`/topology/labels/${dbId}`, { x, y }).catch((err) => setError(err.message));
    } else if (cellType === 'shape') {
      client.patch(`/topology/shapes/${dbId}`, { x, y }).catch((err) => setError(err.message));
    }
  }, []);

  const handleNodeResized = useCallback((rfId, x, y, width, height) => {
    const cellType = cellTypeFromRfId(rfId);
    const dbId = rfIdToDbId(rfId);
    setNodesCache((prev) => prev.map((n) => n._rfId === rfId ? { ...n, x, y, width, height } : n));
    if (cellType === 'device') {
      client.patch('/topology/layout', { positions: [{ node_id: dbId, x, y, width, height }] })
        .catch((err) => setError(err.message));
    } else if (cellType === 'zone') {
      client.patch(`/topology/zones/${dbId}`, { x, y, width, height }).catch((err) => setError(err.message));
    } else if (cellType === 'shape') {
      client.patch(`/topology/shapes/${dbId}`, { x, y, width, height }).catch((err) => setError(err.message));
    }
  }, []);

  const handleEdgeVertexChanged = useCallback((rfId, vertices) => {
    const dbId = rfIdToDbId(rfId);
    const waypoint_x = vertices.length > 0 ? vertices[0].x : null;
    const waypoint_y = vertices.length > 0 ? vertices[0].y : null;
    setEdgesCache((prev) => prev.map((e) => `edge-${e.id}` === rfId ? { ...e, waypoint_x, waypoint_y } : e));
    client.patch(`/topology/edges/${dbId}`, { waypoint_x, waypoint_y })
      .catch((err) => setError(err.message));
  }, []);

  // ── Edge connect flow ─────────────────────────────────────────────────────
  const handleEdgePendingConnect = useCallback(({ edge, sourceId, targetId, sourcePort, targetPort }) => {
    const srcNode = nodesCache.find((n) => n._rfId === sourceId);
    const tgtNode = nodesCache.find((n) => n._rfId === targetId);
    setPendingConnection({
      x6Edge: edge,
      source: sourceId,
      target: targetId,
      sourceHandle: sourcePort,
      targetHandle: targetPort,
      sourceDevice: { id: srcNode?.deviceId, hostname: srcNode?.hostname || srcNode?.name || srcNode?.text || sourceId },
      targetDevice: { id: tgtNode?.deviceId, hostname: tgtNode?.hostname || tgtNode?.name || tgtNode?.text || targetId },
    });
  }, [nodesCache]);

  const handleConnectionSubmit = useCallback(async (formValues) => {
    if (!pendingConnection) return;
    const { x6Edge, source, target, sourceHandle, targetHandle } = pendingConnection;
    try {
      const srcType = cellTypeFromRfId(source);
      const tgtType = cellTypeFromRfId(target);
      const res = await client.post('/topology/edges', {
        source_node_id: rfIdToDbId(source),
        target_node_id: rfIdToDbId(target),
        source_element_type: srcType === 'device' ? 'node' : srcType,
        target_element_type: tgtType === 'device' ? 'node' : tgtType,
        source_handle: sourceHandle,
        target_handle: targetHandle,
        topology_id: activeTopologyId,
        ...formValues,
      });
      canvasRef.current?.finalizeEdge(x6Edge, res.data, showEdgeLabels);
      setEdgesCache((prev) => [...prev, res.data]);
    } catch (err) {
      canvasRef.current?.removeEdge(x6Edge.id);
      setError(err.message);
    } finally {
      setPendingConnection(null);
      setMode('select');
    }
  }, [pendingConnection, activeTopologyId, showEdgeLabels]);

  const handleConnectionCancel = useCallback(() => {
    if (pendingConnection?.x6Edge) {
      canvasRef.current?.removeEdge(pendingConnection.x6Edge.id);
    }
    setPendingConnection(null);
    setMode('select');
  }, [pendingConnection]);

  // ── Edge edit flow ────────────────────────────────────────────────────────
  const handleEditConnectionSubmit = useCallback(async (formValues) => {
    if (!editingEdge) return;
    const rfId = `edge-${editingEdge.id}`;
    try {
      const res = await client.patch(`/topology/edges/${editingEdge.id}`, formValues);
      canvasRef.current?.updateEdge(rfId, res.data, showEdgeLabels);
      setEdgesCache((prev) => prev.map((e) => e.id === editingEdge.id ? res.data : e));
      if (selectedEdgeId === rfId) setSelectedEdgeId(rfId); // keep selected
    } catch (err) {
      setError(err.message);
    } finally {
      setEditingEdge(null);
    }
  }, [editingEdge, showEdgeLabels, selectedEdgeId]);

  // ── Edge property panel update ───────────────────────────────────────────
  const handleUpdateEdge = useCallback((edgeDbId, patch) => {
    const rfId = `edge-${edgeDbId}`;
    setEdgesCache((prev) => prev.map((e) => e.id === edgeDbId ? { ...e, ...patch } : e));
    canvasRef.current?.updateEdge(rfId, { ...edgesCache.find((e) => e.id === edgeDbId), ...patch }, showEdgeLabels);
    client.patch(`/topology/edges/${edgeDbId}`, patch).catch((err) => setError(err.message));
  }, [edgesCache, showEdgeLabels]);

  // Edge style copy/paste clipboard
  const edgeStyleClipboardRef = useRef(null);
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
  const handlePasteEdgeStyle = useCallback((edgeDbId) => {
    if (!edgeStyleClipboardRef.current) return;
    handleUpdateEdge(edgeDbId, edgeStyleClipboardRef.current);
  }, [handleUpdateEdge]);

  // ── Node property panel handlers ─────────────────────────────────────────
  const handleUpdateDevice = useCallback((deviceId, patch) => {
    setNodesCache((prev) => prev.map((n) => n.deviceId === deviceId ? { ...n, ...patch } : n));
    if (selectedNodeId) canvasRef.current?.updateNode(selectedNodeId, patch);
    client.patch(`/devices/${deviceId}`, patch).catch((err) => setError(err.message));
  }, [selectedNodeId]);

  const handleUpdateNode = useCallback((nodeId, patch) => {
    const displayPatch = 'label' in patch ? { ...patch, hostname: patch.label } : patch;
    setNodesCache((prev) => prev.map((n) => n.id === nodeId ? { ...n, ...displayPatch } : n));
    if (selectedNodeId) canvasRef.current?.updateNode(selectedNodeId, displayPatch);
    client.patch(`/topology/nodes/${nodeId}`, patch).catch((err) => setError(err.message));
  }, [selectedNodeId]);

  const handleNodeLabelChange = useCallback((rfId, label) => {
    if (rfId) canvasRef.current?.updateNode(rfId, { hostname: label, label });
  }, []);

  const handleRemoveSelected = useCallback(() => {
    if (!selectedNodeId) return;
    const g = canvasRef.current?.getGraph();
    const cell = g?.getCellById(selectedNodeId);
    if (cell) g.removeCell(cell);
    setSelectedNodeId(null);
  }, [selectedNodeId]);

  const handleDeleteSelectedEdge = useCallback((rfId) => {
    const g = canvasRef.current?.getGraph();
    const cell = g?.getCellById(rfId);
    if (cell) g.removeCell(cell);
    setSelectedEdgeId(null);
  }, []);

  const handleCopyNode = useCallback(async () => {
    if (!selectedNode) return;
    try {
      const res = await client.post('/topology/nodes', {
        label: selectedNode.hostname ? `${selectedNode.hostname} (copy)` : null,
        type: selectedNode.type,
        icon_color: selectedNode.icon_color,
        text_color: selectedNode.text_color,
        x: (selectedNode.x || 0) + 40,
        y: (selectedNode.y || 0) + 40,
        topology_id: activeTopologyId,
      });
      const newData = buildDeviceNodeData(res.data);
      setNodesCache((prev) => [...prev, newData]);
      canvasRef.current?.addNode(newData);
      setSelectedNodeId(newData._rfId);
    } catch (err) {
      setError(err.message);
    }
  }, [selectedNode, activeTopologyId]);

  const handleConnectionPointsChange = useCallback((deviceId, points) => {
    setConnectionPointsByDevice((prev) => ({ ...prev, [deviceId]: points }));
  }, []);

  // ── Zone callbacks (passed via context) ─────────────────────────────────
  const handleZoneUpdate = useCallback((zoneId, patch) => {
    setNodesCache((prev) => prev.map((n) => n.id === zoneId && n._cellType === 'zone' ? { ...n, ...patch } : n));
    client.patch(`/topology/zones/${zoneId}`, patch).catch((err) => setError(err.message));
  }, []);

  const handleZoneDelete = useCallback((rfId) => {
    const g = canvasRef.current?.getGraph();
    const cell = g?.getCellById(rfId);
    if (cell) g.removeCell(cell);
  }, []);

  // ── Shape callbacks (passed via context) ─────────────────────────────────
  const handleShapeUpdate = useCallback((shapeId, patch) => {
    setNodesCache((prev) => prev.map((n) => n.id === shapeId && n._cellType === 'shape' ? { ...n, ...patch } : n));
    client.patch(`/topology/shapes/${shapeId}`, patch).catch((err) => setError(err.message));
  }, []);

  const handleShapeDelete = useCallback((rfId) => {
    const g = canvasRef.current?.getGraph();
    const cell = g?.getCellById(rfId);
    if (cell) g.removeCell(cell);
  }, []);

  // ── Label callbacks (passed via context) ─────────────────────────────────
  const handleLabelChange = useCallback((labelId, text) => {
    setNodesCache((prev) => prev.map((n) => n.id === labelId && n._cellType === 'label' ? { ...n, text } : n));
    client.patch(`/topology/labels/${labelId}`, { text }).catch((err) => setError(err.message));
  }, []);

  const handleLabelDelete = useCallback((rfId) => {
    const g = canvasRef.current?.getGraph();
    const cell = g?.getCellById(rfId);
    if (cell) g.removeCell(cell);
  }, []);

  const handleNodeDblClick = useCallback((deviceId) => {
    navigate(`/devices/${deviceId}`);
  }, [navigate]);

  // Context value for node cells
  const contextValue = useMemo(() => ({
    onZoneUpdate: handleZoneUpdate,
    onZoneDelete: handleZoneDelete,
    onShapeUpdate: handleShapeUpdate,
    onShapeDelete: handleShapeDelete,
    onLabelChange: handleLabelChange,
    onLabelDelete: handleLabelDelete,
    onNodeDblClick: handleNodeDblClick,
    vlans,
    mode,
  }), [handleZoneUpdate, handleZoneDelete, handleShapeUpdate, handleShapeDelete,
      handleLabelChange, handleLabelDelete, handleNodeDblClick, vlans, mode]);

  // ── Add-to-canvas actions ────────────────────────────────────────────────
  const addLabelAt = useCallback(async (point) => {
    try {
      const res = await client.post('/topology/labels', { text: '', x: point.x, y: point.y, font_size: 14, topology_id: activeTopologyId });
      const data = buildLabelNodeData(res.data);
      setNodesCache((prev) => [...prev, data]);
      canvasRef.current?.addNode(data);
      setMode('select');
    } catch (err) { setError(err.message); }
  }, [activeTopologyId]);

  const addZoneAt = useCallback(async (point) => {
    try {
      const res = await client.post('/topology/zones', { name: 'Zone', border_style: 'solid', color: 'blue', x: point.x, y: point.y, width: 320, height: 220, topology_id: activeTopologyId });
      const data = buildZoneNodeData(res.data, vlans);
      setNodesCache((prev) => [...prev, data]);
      canvasRef.current?.addNode(data);
      setMode('select');
    } catch (err) { setError(err.message); }
  }, [activeTopologyId, vlans]);

  const addShapeAt = useCallback(async (point, type) => {
    try {
      const res = await client.post('/topology/shapes', { shape_type: type || 'rect', x: point.x, y: point.y, width: 160, height: 100, topology_id: activeTopologyId });
      const data = buildShapeNodeData(res.data);
      setNodesCache((prev) => [...prev, data]);
      canvasRef.current?.addNode(data);
      setMode('select');
    } catch (err) { setError(err.message); }
  }, [activeTopologyId]);

  // ── Drop handler from DevicePicker ──────────────────────────────────────
  const handleDrop = useCallback(async ({ point, manualData, discoveredId }) => {
    if (manualData) {
      setPendingNode({ position: point, deviceInfo: manualData });
    } else if (discoveredId) {
      const deviceId = Number(discoveredId);
      const device = unplacedDevices.find((d) => d.id === deviceId);
      if (!device) return;
      try {
        const res = await client.post('/topology/nodes', { device_id: deviceId, x: point.x, y: point.y, topology_id: activeTopologyId });
        const data = buildDeviceNodeData(res.data);
        setNodesCache((prev) => [...prev, data]);
        canvasRef.current?.addNode(data);
        setUnplacedDevices((devs) => devs.filter((d) => d.id !== deviceId));
        setSelectedNodeId(data._rfId);
      } catch (err) { setError(err.message); }
    }
  }, [unplacedDevices, activeTopologyId]);

  // Canvas click — add elements in text/zone/shape modes
  const handleCanvasClick = useCallback((point) => {
    if (mode === 'text')  { addLabelAt(point); return; }
    if (mode === 'zone')  { addZoneAt(point);  return; }
    if (mode === 'shape') { addShapeAt(point, shapeType); return; }
  }, [mode, shapeType, addLabelAt, addZoneAt, addShapeAt]);

  // ── Add node modal handlers ──────────────────────────────────────────────
  const handleAddNodeStandalone = useCallback(async () => {
    if (!pendingNode) return;
    const { position, deviceInfo } = pendingNode;
    try {
      const res = await client.post('/topology/nodes', { label: deviceInfo.label, type: deviceInfo.type, x: position.x, y: position.y, topology_id: activeTopologyId });
      const data = buildDeviceNodeData(res.data);
      setNodesCache((prev) => [...prev, data]);
      canvasRef.current?.addNode(data);
      setSelectedNodeId(data._rfId);
    } catch (err) { setError(err.message); }
    finally { setPendingNode(null); }
  }, [pendingNode, activeTopologyId]);

  const handleAddNodeLink = useCallback(async (deviceId) => {
    if (!pendingNode) return;
    const { position } = pendingNode;
    try {
      const res = await client.post('/topology/nodes', { device_id: deviceId, x: position.x, y: position.y, topology_id: activeTopologyId });
      const data = buildDeviceNodeData(res.data);
      setNodesCache((prev) => [...prev, data]);
      canvasRef.current?.addNode(data);
      setUnplacedDevices((devs) => devs.filter((d) => d.id !== deviceId));
      setSelectedNodeId(data._rfId);
    } catch (err) { setError(err.message); }
    finally { setPendingNode(null); }
  }, [pendingNode, activeTopologyId]);

  // ── Toolbar actions ───────────────────────────────────────────────────────
  const handleModeChange = useCallback((next) => {
    setMode(next);
    setBackgroundMenuOpen(false);
    setShapeMenuOpen(false);
  }, []);

  const toggleEdgeLabels = useCallback(() => {
    setShowEdgeLabels((prev) => {
      const next = !prev;
      canvasRef.current?.setShowLabels(next);
      return next;
    });
  }, []);

  const handleFitView = useCallback(() => { canvasRef.current?.fitView(); }, []);

  const handleAutoLayout = useCallback(() => {
    const deviceNodes = nodesCache.filter((n) => n._cellType === 'device');
    const rfNodes = deviceNodes.map((n) => ({ id: n._rfId, position: { x: n.x, y: n.y }, style: { width: n.width, height: n.height } }));
    const rfEdges = edgesCache
      .filter((e) => e.source_element_type === 'node' && e.target_element_type === 'node')
      .map((e) => ({ id: `edge-${e.id}`, source: `device-${e.source_node_id}`, target: `device-${e.target_node_id}` }));
    const { nodes: layouted } = getLayoutedElements(rfNodes, rfEdges);
    const g = canvasRef.current?.getGraph();
    if (!g) return;
    layouted.forEach((n) => {
      const cell = g.getCellById(n.id);
      if (cell) cell.setPosition(n.position.x, n.position.y);
    });
    client.patch('/topology/layout', {
      positions: layouted.map((n) => ({ node_id: rfIdToDbId(n.id), x: n.position.x, y: n.position.y })),
    }).catch((err) => setError(err.message));
  }, [nodesCache, edgesCache]);

  const handleSaveAll = useCallback(async () => {
    try {
      const g = canvasRef.current?.getGraph();
      if (!g) return;
      const devicePositions = nodesCache
        .filter((n) => n._cellType === 'device')
        .map((n) => {
          const cell = g.getCellById(n._rfId);
          const pos  = cell?.getPosition() || { x: n.x, y: n.y };
          const size = cell?.getSize()     || { width: n.width, height: n.height };
          return { node_id: n.id, x: pos.x, y: pos.y, width: size.width, height: size.height };
        });
      if (devicePositions.length > 0)
        await client.patch('/topology/layout', { positions: devicePositions });

      await Promise.all([
        ...nodesCache.filter((n) => n._cellType === 'zone').map((n) => {
          const cell = g.getCellById(n._rfId);
          const pos  = cell?.getPosition() || { x: n.x, y: n.y };
          const size = cell?.getSize()     || { width: n.width, height: n.height };
          return client.patch(`/topology/zones/${n.id}`, { x: pos.x, y: pos.y, width: size.width, height: size.height });
        }),
        ...nodesCache.filter((n) => n._cellType === 'shape').map((n) => {
          const cell = g.getCellById(n._rfId);
          const pos  = cell?.getPosition() || { x: n.x, y: n.y };
          const size = cell?.getSize()     || { width: n.width, height: n.height };
          return client.patch(`/topology/shapes/${n.id}`, { x: pos.x, y: pos.y, width: size.width, height: size.height });
        }),
      ]);

      setShowSavedToast(true);
      setTimeout(() => setShowSavedToast(false), 2000);
    } catch (err) { setError(err.message); }
  }, [nodesCache]);

  const handleClearCanvas = useCallback(async () => {
    if (!window.confirm('Clear the canvas? All nodes, edges, zones, and labels will be permanently removed.')) return;
    try {
      await client.delete(`/topology/all${activeTopologyId ? `?topologyId=${activeTopologyId}` : ''}`);
      const devicesBack = nodesCache
        .filter((n) => n._cellType === 'device' && n.deviceId)
        .map((n) => ({ id: n.deviceId, hostname: n.hostname, ip: n.ip, mac: n.mac, device_type: n.type }));
      setUnplacedDevices((prev) => [...prev, ...devicesBack]);
      setNodesCache([]);
      setEdgesCache([]);
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      canvasRef.current?.getGraph()?.clearCells();
    } catch (err) { setError(err.message); }
  }, [nodesCache, activeTopologyId]);

  const handleExport = useCallback(async (format) => {
    setExportMenuOpen(false);
    setExporting(true);
    try {
      const dataUrl = await canvasRef.current?.toDataUrl(format === 'svg' ? 'svg' : 'png');
      if (!dataUrl) return;
      if (format === 'pdf') {
        const { default: jsPDF } = await import('jspdf');
        const img = new Image();
        img.src = dataUrl;
        await new Promise((resolve) => { img.onload = resolve; });
        const pdf = new jsPDF({ orientation: img.width >= img.height ? 'landscape' : 'portrait', unit: 'px', format: [img.width, img.height] });
        pdf.addImage(dataUrl, 'PNG', 0, 0, img.width, img.height);
        pdf.save('rackpath-topology.pdf');
      } else {
        const link = document.createElement('a');
        link.download = `rackpath-topology.${format}`;
        link.href = dataUrl;
        link.click();
      }
    } catch (err) { setError(err.message); }
    finally { setExporting(false); }
  }, []);

  // ── Topology CRUD ─────────────────────────────────────────────────────────
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
    if (!window.confirm(`Delete "${topo.name}"? All canvas data will be permanently removed.`)) return;
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
    setLoading(true);
    setNodesCache([]);
    setEdgesCache([]);
    canvasRef.current?.getGraph()?.clearCells();
    setActiveTopologyId(id);
  }, []);

  // ── Undo / Redo ───────────────────────────────────────────────────────────
  const handleUndo = useCallback(() => canvasRef.current?.undo(), []);
  const handleRedo = useCallback(() => canvasRef.current?.redo(), []);

  // ── Align / Distribute ────────────────────────────────────────────────────
  const handleAlign = useCallback((dir) => canvasRef.current?.alignSelected(dir), []);
  const handleDistribute = useCallback((dir) => canvasRef.current?.distributeSelected(dir), []);

  // ── Escape to select mode ─────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && mode !== 'select') handleModeChange('select');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode, handleModeChange]);

  // ── Click on canvas in placement modes ───────────────────────────────────
  useEffect(() => {
    const g = canvasRef.current?.getGraph();
    if (!g) return;
    const handler = ({ x, y }) => {
      if (mode === 'text' || mode === 'zone' || mode === 'shape') {
        handleCanvasClick({ x, y });
      }
    };
    g.on('blank:click', handler);
    return () => g.off('blank:click', handler);
  // Re-register when mode or canvas changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, handleCanvasClick]);

  // ── Render ────────────────────────────────────────────────────────────────

  const selNodeData = selectedNode
    ? { type: 'device', id: selectedNodeId, data: selectedNode }
    : null;

  // Reconstruct a node-panel compatible object
  const panelNode = selNodeData
    ? {
        id: selectedNodeId,
        type: selectedNode._cellType === 'device' ? 'device' : selectedNode._cellType,
        data: selectedNode,
      }
    : null;

  const editSrcNode = editingEdge
    ? nodesCache.find((n) => n._rfId === rfIdFromElementType(editingEdge.source_element_type, editingEdge.source_node_id))
    : null;
  const editTgtNode = editingEdge
    ? nodesCache.find((n) => n._rfId === rfIdFromElementType(editingEdge.target_element_type, editingEdge.target_node_id))
    : null;

  const selectedCount = canvasRef.current?.getSelectedNodes()?.length ?? 0;

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
        onBackgroundChange={(bg) => { setBackground(bg); setBackgroundMenuOpen(false); }}
        showEdgeLabels={showEdgeLabels}
        onToggleEdgeLabels={toggleEdgeLabels}
        showGrid={showGrid}
        onToggleGrid={() => setShowGrid((v) => !v)}
        showMinimap={showMinimap}
        onToggleMinimap={() => setShowMinimap((v) => !v)}
        onSave={handleSaveAll}
        onExport={handleExport}
        exporting={exporting}
        exportMenuOpen={exportMenuOpen}
        onToggleExportMenu={() => setExportMenuOpen((o) => !o)}
        onClearCanvas={handleClearCanvas}
        onFitView={handleFitView}
        onZoomIn={() => canvasRef.current?.zoomIn()}
        onZoomOut={() => canvasRef.current?.zoomOut()}
        onAutoLayout={handleAutoLayout}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onAlign={handleAlign}
        onDistribute={handleDistribute}
        selectedCount={selectedCount}
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

        <div className={`topology-canvas topology-mode-${mode}`}>
          {loading && <div className="topology-canvas-loading">Loading topology…</div>}
          <X6Canvas
            ref={canvasRef}
            contextValue={contextValue}
            background={background}
            showGrid={showGrid}
            showMinimap={showMinimap}
            mode={mode}
            onNodeSelect={handleNodeSelect}
            onEdgeSelect={handleEdgeSelect}
            onSelectionClear={handleSelectionClear}
            onEdgePendingConnect={handleEdgePendingConnect}
            onNodeDeleted={handleNodeDeleted}
            onEdgeDeleted={handleEdgeDeleted}
            onNodeMoved={handleNodeMoved}
            onNodeResized={handleNodeResized}
            onEdgeVertexChanged={handleEdgeVertexChanged}
            onDrop={handleDrop}
          />

          <NodePropertiesPanel
            node={panelNode}
            onClose={() => setSelectedNodeId(null)}
            onUpdateDevice={handleUpdateDevice}
            onUpdateNode={handleUpdateNode}
            onDelete={handleRemoveSelected}
            onCopy={handleCopyNode}
            onConnectionPointsChange={handleConnectionPointsChange}
            onLabelChange={handleNodeLabelChange}
          />

          <EdgePropertiesPanel
            edge={selectedEdgePanelObj}
            sourceHostname={selectedEdgeSourceNode?.hostname || selectedEdgeSourceNode?.label || (selectedEdgeSourceNode ? `Node ${selectedEdgeSourceNode.id}` : '')}
            targetHostname={selectedEdgeTargetNode?.hostname || selectedEdgeTargetNode?.label || (selectedEdgeTargetNode ? `Node ${selectedEdgeTargetNode.id}` : '')}
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
          onCancel={handleConnectionCancel}
        />
      )}

      {editingEdge && (
        <LinkConfigModal
          initialValues={editingEdge}
          sourceDevice={{ id: editSrcNode?.deviceId, hostname: editSrcNode?.hostname || editSrcNode?.label }}
          targetDevice={{ id: editTgtNode?.deviceId, hostname: editTgtNode?.hostname || editTgtNode?.label }}
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
