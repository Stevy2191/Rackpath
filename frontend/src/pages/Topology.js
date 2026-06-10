import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
} from 'reactflow';
import 'reactflow/dist/style.css';
import client from '../api/client';
import DeviceNode from '../components/DeviceNode';
import { getLayoutedElements } from '../utils/layout';
import './Topology.css';

const nodeTypes = { device: DeviceNode };

function buildNodes(devices) {
  return devices.map((device) => ({
    id: String(device.id),
    type: 'device',
    position: { x: device.x || 0, y: device.y || 0 },
    data: {
      label: device.hostname || device.ip || `Device ${device.id}`,
      ip: device.ip,
      mac: device.mac,
      type: device.type,
      snmp_community: device.snmp_community,
      notes: device.notes,
    },
  }));
}

function buildEdges(links) {
  return links.map((link) => ({
    id: `edge-${link.id}`,
    source: String(link.source),
    target: String(link.target),
    label: link.port_name || undefined,
  }));
}

export default function TopologyPage() {
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [scanSubnet, setScanSubnet] = useState('');
  const [scanStatus, setScanStatus] = useState(null);

  const loadTopology = useCallback(() => {
    return client
      .get('/topology')
      .then((res) => {
        setNodes(buildNodes(res.data.nodes || []));
        setEdges(buildEdges(res.data.edges || []));
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    loadTopology().finally(() => setLoading(false));
  }, [loadTopology]);

  const onNodesChange = useCallback((changes) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const onNodeDragStop = useCallback((_event, node) => {
    client
      .put(`/topology/${node.id}`, { x: node.position.x, y: node.position.y })
      .catch((err) => setError(err.message));
  }, []);

  const onNodeClick = useCallback((_event, node) => {
    setSelectedNodeId(node.id);
  }, []);

  const handleAutoLayout = useCallback(() => {
    const { nodes: layoutedNodes } = getLayoutedElements(nodes, edges);
    setNodes(layoutedNodes);

    Promise.all(
      layoutedNodes.map((node) =>
        client.put(`/topology/${node.id}`, { x: node.position.x, y: node.position.y })
      )
    ).catch((err) => setError(err.message));
  }, [nodes, edges]);

  const handleStartScan = useCallback(
    async (e) => {
      e.preventDefault();
      setScanStatus('starting');
      setError(null);
      try {
        const res = await client.post('/scans', { target_subnet: scanSubnet });
        setScanStatus(`Started scan #${res.data.id} (${res.data.status})`);
      } catch (err) {
        setError(err.message);
        setScanStatus(null);
      }
    },
    [scanSubnet]
  );

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || null,
    [nodes, selectedNodeId]
  );

  if (loading) return <div className="page-status">Loading topology...</div>;

  return (
    <div className="topology-page">
      {error && <div className="page-error">{error}</div>}

      <div className="topology-toolbar">
        <form className="topology-scan-form" onSubmit={handleStartScan}>
          <input
            value={scanSubnet}
            onChange={(e) => setScanSubnet(e.target.value)}
            placeholder="Subnet, e.g. 192.168.1.0/24"
            required
          />
          <button type="submit">New Scan</button>
        </form>
        {scanStatus && <span className="topology-scan-status">{scanStatus}</span>}
        <button type="button" className="topology-layout-btn" onClick={handleAutoLayout}>
          Auto Layout
        </button>
      </div>

      <div className="topology-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={onNodeClick}
          onPaneClick={() => setSelectedNodeId(null)}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>

        {selectedNode && (
          <aside className="topology-sidebar">
            <button className="topology-sidebar-close" onClick={() => setSelectedNodeId(null)}>
              &times;
            </button>
            <h3>{selectedNode.data.label}</h3>
            <dl>
              <dt>IP Address</dt>
              <dd>{selectedNode.data.ip || '-'}</dd>
              <dt>MAC Address</dt>
              <dd>{selectedNode.data.mac || '-'}</dd>
              <dt>Type</dt>
              <dd>{selectedNode.data.type || '-'}</dd>
              <dt>SNMP Community</dt>
              <dd>{selectedNode.data.snmp_community || '-'}</dd>
              <dt>Notes</dt>
              <dd>{selectedNode.data.notes || '-'}</dd>
            </dl>
          </aside>
        )}
      </div>
    </div>
  );
}
