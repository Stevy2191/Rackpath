import React, { useCallback, useEffect, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
} from 'reactflow';
import 'reactflow/dist/style.css';
import client from '../api/client';
import './Topology.css';

function buildNodes(devices) {
  return devices.map((device) => ({
    id: String(device.id),
    position: { x: device.x || 0, y: device.y || 0 },
    data: { label: device.hostname || device.ip || `Device ${device.id}` },
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

  useEffect(() => {
    let cancelled = false;
    client
      .get('/topology')
      .then((res) => {
        if (cancelled) return;
        setNodes(buildNodes(res.data.nodes || []));
        setEdges(buildEdges(res.data.edges || []));
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const onNodesChange = useCallback((changes) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const onNodeDragStop = useCallback((_event, node) => {
    client
      .put(`/topology/${node.id}`, { x: node.position.x, y: node.position.y })
      .catch((err) => setError(err.message));
  }, []);

  if (loading) return <div className="page-status">Loading topology...</div>;

  return (
    <div className="topology-page">
      {error && <div className="page-error">{error}</div>}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        fitView
      >
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}
