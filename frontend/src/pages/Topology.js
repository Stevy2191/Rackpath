import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactFlow, {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  ReactFlowProvider,
  useReactFlow,
  useUpdateNodeInternals,
} from 'reactflow';
import 'reactflow/dist/style.css';
import client from '../api/client';
import DeviceNode from '../components/DeviceNode';
import ZoneNode from '../components/topology/ZoneNode';
import ConnectionEdge from '../components/topology/ConnectionEdge';
import DevicePicker, {
  MANUAL_DRAG_TYPE,
  DISCOVERED_DRAG_TYPE,
} from '../components/topology/DevicePicker';
import QuickInfoPanel from '../components/topology/QuickInfoPanel';
import ConnectionModal from '../components/topology/ConnectionModal';
import ZoneFormModal from '../components/topology/ZoneFormModal';
import AddDeviceModal from '../components/topology/AddDeviceModal';
import { getLayoutedElements } from '../utils/layout';
import './Topology.css';

const nodeTypes = { device: DeviceNode, zone: ZoneNode };
const edgeTypes = { connection: ConnectionEdge };

function buildDeviceNode(device, callbacks) {
  return {
    id: `device-${device.id}`,
    type: 'device',
    position: { x: device.x || 0, y: device.y || 0 },
    style: { width: device.width || 120, height: device.height || 80 },
    data: {
      id: device.id,
      hostname: device.hostname,
      ip: device.ip,
      mac: device.mac,
      type: device.type,
      snmp_community: device.snmp_community,
      notes: device.notes,
      updated_at: device.updated_at,
      onResizeEnd: callbacks?.onDeviceResizeEnd,
    },
  };
}

function buildZoneNode(zone, callbacks) {
  return {
    id: `zone-${zone.id}`,
    type: 'zone',
    position: { x: zone.x, y: zone.y },
    style: { width: zone.width, height: zone.height },
    zIndex: -1,
    data: {
      id: zone.id,
      name: zone.name,
      border_style: zone.border_style,
      color: zone.color,
      onResizeEnd: callbacks.onZoneResizeEnd,
      onDelete: callbacks.onZoneDelete,
    },
  };
}

function edgeLabelText(edge) {
  const parts = [];
  if (edge.label) parts.push(edge.label);
  if (edge.vlan) parts.push(`VLAN ${edge.vlan}`);
  if (edge.speed) parts.push(edge.speed);
  if (edge.cable_type) parts.push(edge.cable_type);
  return parts.join(' · ') || undefined;
}

function buildEdge(edge, showLabels, callbacks) {
  return {
    id: `edge-${edge.id}`,
    source: `device-${edge.source_device_id}`,
    target: `device-${edge.target_device_id}`,
    sourceHandle: edge.source_handle || null,
    targetHandle: edge.target_handle || null,
    type: 'connection',
    label: showLabels ? edgeLabelText(edge) : undefined,
    data: {
      ...edge,
      onEdit: callbacks?.onEdgeEdit,
      onDelete: callbacks?.onEdgeDelete,
    },
  };
}

function deviceIdFromNodeId(nodeId) {
  return Number(nodeId.replace('device-', ''));
}

function zoneIdFromNodeId(nodeId) {
  return Number(nodeId.replace('zone-', ''));
}

function TopologyCanvas() {
  const navigate = useNavigate();
  const reactFlowInstance = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const reactFlowWrapper = useRef(null);

  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [unplacedDevices, setUnplacedDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [showEdgeLabels, setShowEdgeLabels] = useState(true);
  const [pendingConnection, setPendingConnection] = useState(null);
  const [editingEdge, setEditingEdge] = useState(null);
  const [pendingManualDrop, setPendingManualDrop] = useState(null);
  const [showZoneModal, setShowZoneModal] = useState(false);

  const handleDeviceResizeEnd = useCallback(
    (nodeId, params) => {
      const deviceId = deviceIdFromNodeId(nodeId);
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
      // Resizing moves the node's handles, so React Flow's cached handle
      // bounds need to be recalculated or edges will keep rendering at the
      // pre-resize positions.
      updateNodeInternals(nodeId);
      client
        .patch('/topology/layout', {
          positions: [
            { device_id: deviceId, x: params.x, y: params.y, width: params.width, height: params.height },
          ],
        })
        .catch((err) => setError(err.message));
    },
    [updateNodeInternals]
  );

  const handleEdgeEdit = useCallback(
    (edgeId) => {
      const edge = reactFlowInstance.getEdge(edgeId);
      if (edge) setEditingEdge(edge);
    },
    [reactFlowInstance]
  );

  const handleEdgeDelete = useCallback(
    (edgeId) => {
      reactFlowInstance.deleteElements({ edges: [{ id: edgeId }] });
    },
    [reactFlowInstance]
  );

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
      reactFlowInstance.deleteElements({ nodes: [{ id: nodeId }] });
    },
    [reactFlowInstance]
  );

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [topoRes, edgesRes, zonesRes, unplacedRes] = await Promise.all([
          client.get('/topology'),
          client.get('/topology/edges'),
          client.get('/topology/zones'),
          client.get('/devices', { params: { unplaced: true } }),
        ]);
        if (cancelled) return;

        const deviceNodes = (topoRes.data.nodes || []).map((device) =>
          buildDeviceNode(device, { onDeviceResizeEnd: handleDeviceResizeEnd })
        );
        const zoneNodes = (zonesRes.data || []).map((zone) =>
          buildZoneNode(zone, { onZoneResizeEnd: handleZoneResizeEnd, onZoneDelete: handleZoneDelete })
        );

        setNodes([...zoneNodes, ...deviceNodes]);
        setEdges(
          (edgesRes.data || []).map((edge) =>
            buildEdge(edge, true, { onEdgeEdit: handleEdgeEdit, onEdgeDelete: handleEdgeDelete })
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
  }, [handleZoneResizeEnd, handleZoneDelete, handleDeviceResizeEnd, handleEdgeEdit, handleEdgeDelete]);

  const onNodesChange = useCallback(
    (changes) => {
      changes.forEach((change) => {
        if (change.type !== 'remove') return;

        if (change.id.startsWith('device-')) {
          const deviceId = deviceIdFromNodeId(change.id);
          const node = nodes.find((n) => n.id === change.id);
          client.delete(`/topology/nodes/${deviceId}`).catch((err) => setError(err.message));
          if (node) {
            setUnplacedDevices((devs) => [...devs, { ...node.data }]);
          }
        } else if (change.id.startsWith('zone-')) {
          const zoneId = zoneIdFromNodeId(change.id);
          client.delete(`/topology/zones/${zoneId}`).catch((err) => setError(err.message));
        }
      });

      setNodes((nds) => applyNodeChanges(changes, nds));
    },
    [nodes]
  );

  const onEdgesChange = useCallback(
    (changes) => {
      changes.forEach((change) => {
        if (change.type === 'remove') {
          const edgeId = Number(change.id.replace('edge-', ''));
          client.delete(`/topology/edges/${edgeId}`).catch((err) => setError(err.message));

          // Reset the cached handle bounds on both endpoints so a fresh
          // connection started from the same handle isn't influenced by the
          // deleted edge's stale state.
          const removed = reactFlowInstance.getEdge(change.id);
          if (removed) {
            updateNodeInternals(removed.source);
            updateNodeInternals(removed.target);
          }
        }
      });

      setEdges((eds) => applyEdgeChanges(changes, eds));
    },
    [reactFlowInstance, updateNodeInternals]
  );

  const onConnect = useCallback((params) => {
    if (!params.source || !params.target || params.source === params.target) return;
    // Build a fresh object from the connection params rather than holding on
    // to React Flow's internal params reference, so a new connection never
    // reuses a stale handle from a previously deleted edge.
    setPendingConnection({
      source: params.source,
      sourceHandle: params.sourceHandle ?? null,
      target: params.target,
      targetHandle: params.targetHandle ?? null,
    });
  }, []);

  const handleConnectionSubmit = useCallback(
    async (formValues) => {
      if (!pendingConnection) return;
      try {
        const res = await client.post('/topology/edges', {
          source_device_id: deviceIdFromNodeId(pendingConnection.source),
          target_device_id: deviceIdFromNodeId(pendingConnection.target),
          source_handle: pendingConnection.sourceHandle,
          target_handle: pendingConnection.targetHandle,
          ...formValues,
        });
        setEdges((eds) =>
          addEdge(
            buildEdge(res.data, showEdgeLabels, { onEdgeEdit: handleEdgeEdit, onEdgeDelete: handleEdgeDelete }),
            eds
          )
        );
      } catch (err) {
        setError(err.message);
      } finally {
        setPendingConnection(null);
      }
    },
    [pendingConnection, showEdgeLabels, handleEdgeEdit, handleEdgeDelete]
  );

  const handleEditConnectionSubmit = useCallback(
    async (formValues) => {
      if (!editingEdge) return;
      const edgeDbId = Number(editingEdge.id.replace('edge-', ''));
      try {
        const res = await client.patch(`/topology/edges/${edgeDbId}`, formValues);
        setEdges((eds) =>
          eds.map((e) =>
            e.id === editingEdge.id
              ? buildEdge(res.data, showEdgeLabels, { onEdgeEdit: handleEdgeEdit, onEdgeDelete: handleEdgeDelete })
              : e
          )
        );
      } catch (err) {
        setError(err.message);
      } finally {
        setEditingEdge(null);
      }
    },
    [editingEdge, showEdgeLabels, handleEdgeEdit, handleEdgeDelete]
  );

  const onEdgeUpdate = useCallback(
    (oldEdge, newConnection) => {
      const edgeDbId = Number(oldEdge.id.replace('edge-', ''));
      client
        .patch(`/topology/edges/${edgeDbId}`, {
          source_device_id: deviceIdFromNodeId(newConnection.source),
          target_device_id: deviceIdFromNodeId(newConnection.target),
          source_handle: newConnection.sourceHandle ?? null,
          target_handle: newConnection.targetHandle ?? null,
        })
        .then((res) => {
          setEdges((eds) =>
            eds.map((e) =>
              e.id === oldEdge.id
                ? buildEdge(res.data, showEdgeLabels, { onEdgeEdit: handleEdgeEdit, onEdgeDelete: handleEdgeDelete })
                : e
            )
          );
        })
        .catch((err) => setError(err.message));
    },
    [showEdgeLabels, handleEdgeEdit, handleEdgeDelete]
  );

  const toggleEdgeLabels = useCallback(() => {
    setShowEdgeLabels((prev) => {
      const next = !prev;
      setEdges((eds) => eds.map((e) => ({ ...e, label: next ? edgeLabelText(e.data) : undefined })));
      return next;
    });
  }, []);

  const onNodeDragStop = useCallback((_event, node) => {
    if (node.type === 'device') {
      client
        .patch('/topology/layout', {
          positions: [{ device_id: deviceIdFromNodeId(node.id), x: node.position.x, y: node.position.y }],
        })
        .catch((err) => setError(err.message));
    } else if (node.type === 'zone') {
      client
        .patch(`/topology/zones/${zoneIdFromNodeId(node.id)}`, { x: node.position.x, y: node.position.y })
        .catch((err) => setError(err.message));
    }
  }, []);

  const onNodeClick = useCallback((_event, node) => {
    if (node.type === 'device') setSelectedNode(node);
  }, []);

  const onNodeDoubleClick = useCallback(
    (_event, node) => {
      if (node.type === 'device') navigate(`/devices/${node.data.id}`);
    },
    [navigate]
  );

  const onPaneClick = useCallback(() => setSelectedNode(null), []);

  const handleRemoveSelected = useCallback(() => {
    if (!selectedNode) return;
    reactFlowInstance.deleteElements({ nodes: [{ id: selectedNode.id }] });
    setSelectedNode(null);
  }, [selectedNode, reactFlowInstance]);

  const handleAutoLayout = useCallback(() => {
    const deviceNodes = nodes.filter((n) => n.type === 'device');
    const zoneNodes = nodes.filter((n) => n.type === 'zone');
    const { nodes: layouted } = getLayoutedElements(deviceNodes, edges);

    setNodes([...zoneNodes, ...layouted]);

    client
      .patch('/topology/layout', {
        positions: layouted.map((n) => ({
          device_id: deviceIdFromNodeId(n.id),
          x: n.position.x,
          y: n.position.y,
        })),
      })
      .catch((err) => setError(err.message));
  }, [nodes, edges]);

  const handleFitView = useCallback(() => {
    reactFlowInstance.fitView({ padding: 0.2 });
  }, [reactFlowInstance]);

  const handleAddZone = useCallback(
    async ({ name, border_style, color }) => {
      try {
        let position = { x: 100, y: 100 };
        if (reactFlowWrapper.current) {
          const bounds = reactFlowWrapper.current.getBoundingClientRect();
          position = reactFlowInstance.project({ x: bounds.width / 2 - 160, y: bounds.height / 2 - 110 });
        }

        const res = await client.post('/topology/zones', {
          name,
          border_style,
          color,
          x: position.x,
          y: position.y,
          width: 320,
          height: 220,
        });

        setNodes((nds) => [
          buildZoneNode(res.data, { onZoneResizeEnd: handleZoneResizeEnd, onZoneDelete: handleZoneDelete }),
          ...nds,
        ]);
      } catch (err) {
        setError(err.message);
      } finally {
        setShowZoneModal(false);
      }
    },
    [reactFlowInstance, handleZoneResizeEnd, handleZoneDelete]
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
        setPendingManualDrop({ deviceInfo: JSON.parse(manualData), position });
      } else if (discoveredId) {
        const deviceId = Number(discoveredId);
        const device = unplacedDevices.find((d) => d.id === deviceId);
        if (!device) return;

        try {
          await client.patch('/topology/layout', {
            positions: [{ device_id: deviceId, x: position.x, y: position.y }],
          });
          setNodes((nds) => [
            ...nds,
            buildDeviceNode({ ...device, x: position.x, y: position.y }, { onDeviceResizeEnd: handleDeviceResizeEnd }),
          ]);
          setUnplacedDevices((devs) => devs.filter((d) => d.id !== deviceId));
        } catch (err) {
          setError(err.message);
        }
      }
    },
    [reactFlowInstance, unplacedDevices, handleDeviceResizeEnd]
  );

  const handleManualDeviceSubmit = useCallback(
    async ({ hostname, ip }) => {
      if (!pendingManualDrop) return;
      try {
        const res = await client.post('/topology/nodes', {
          hostname,
          ip,
          type: pendingManualDrop.deviceInfo.type,
          x: pendingManualDrop.position.x,
          y: pendingManualDrop.position.y,
        });
        setNodes((nds) => [...nds, buildDeviceNode(res.data, { onDeviceResizeEnd: handleDeviceResizeEnd })]);
      } catch (err) {
        setError(err.message);
      } finally {
        setPendingManualDrop(null);
      }
    },
    [pendingManualDrop, handleDeviceResizeEnd]
  );

  if (loading) return <div className="page-status">Loading topology...</div>;

  return (
    <div className="topology-page">
      {error && <div className="page-error">{error}</div>}

      <div className="topology-toolbar">
        <button type="button" onClick={handleAutoLayout}>
          Auto Layout
        </button>
        <button type="button" onClick={() => setShowZoneModal(true)}>
          Add Zone
        </button>
        <button type="button" onClick={handleFitView}>
          Fit View
        </button>
        <label className="topology-toggle">
          <input type="checkbox" checked={showEdgeLabels} onChange={toggleEdgeLabels} />
          Show edge labels
        </label>
      </div>

      <div className="topology-body">
        <DevicePicker unplacedDevices={unplacedDevices} />

        <div className="topology-canvas" ref={reactFlowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            connectionMode={ConnectionMode.Loose}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onEdgeUpdate={onEdgeUpdate}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onPaneClick={onPaneClick}
            onDrop={onDrop}
            onDragOver={onDragOver}
            deleteKeyCode={['Backspace', 'Delete']}
            fitView
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--color-border-strong)" />
            <Controls />
          </ReactFlow>

          <QuickInfoPanel node={selectedNode} onClose={() => setSelectedNode(null)} onRemove={handleRemoveSelected} />
        </div>
      </div>

      {pendingConnection && (
        <ConnectionModal onSubmit={handleConnectionSubmit} onCancel={() => setPendingConnection(null)} />
      )}

      {editingEdge && (
        <ConnectionModal
          initialValues={editingEdge.data}
          onSubmit={handleEditConnectionSubmit}
          onCancel={() => setEditingEdge(null)}
        />
      )}

      {showZoneModal && <ZoneFormModal onSubmit={handleAddZone} onCancel={() => setShowZoneModal(false)} />}

      {pendingManualDrop && (
        <AddDeviceModal
          deviceInfo={pendingManualDrop.deviceInfo}
          onSubmit={handleManualDeviceSubmit}
          onCancel={() => setPendingManualDrop(null)}
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
