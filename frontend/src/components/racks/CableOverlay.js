import React, { useEffect, useState } from 'react';
import client from '../../api/client';
import './CableOverlay.css';

// Absolute SVG overlay drawing lines between connected devices that are
// currently visible in the rack canvas (same front/back side, both endpoints
// racked). Toggled via the "Show Cables" control in the Racks toolbar.
export default function CableOverlay({ racks, allSlots }) {
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [lines, setLines] = useState([]);

  useEffect(() => {
    client
      .get('/topology')
      .then((res) => setNodes(res.data?.nodes || []))
      .catch(() => setNodes([]));
    client
      .get('/topology/edges')
      .then((res) => setEdges(res.data || []))
      .catch(() => setEdges([]));
  }, []);

  useEffect(() => {
    if (edges.length === 0 || nodes.length === 0 || allSlots.length === 0) {
      setLines([]);
      return;
    }

    const deviceIdByNodeId = new Map();
    for (const node of nodes) {
      if (node.device_id) deviceIdByNodeId.set(node.id, node.device_id);
    }

    const slotByDeviceId = new Map();
    for (const slot of allSlots) {
      if (slot.device_id) slotByDeviceId.set(slot.device_id, slot);
    }

    const canvasEl = document.querySelector('.rack-canvas');
    if (!canvasEl) return;
    const canvasRect = canvasEl.getBoundingClientRect();

    const next = [];
    for (const edge of edges) {
      const sourceDeviceId = deviceIdByNodeId.get(edge.source_node_id);
      const targetDeviceId = deviceIdByNodeId.get(edge.target_node_id);
      if (!sourceDeviceId || !targetDeviceId) continue;

      const sourceSlot = slotByDeviceId.get(sourceDeviceId);
      const targetSlot = slotByDeviceId.get(targetDeviceId);
      if (!sourceSlot || !targetSlot) continue;
      if ((sourceSlot.front_back || 'front') !== (targetSlot.front_back || 'front')) continue;

      const sourceEl = document.querySelector(`[data-device-id="${sourceDeviceId}"]`);
      const targetEl = document.querySelector(`[data-device-id="${targetDeviceId}"]`);
      if (!sourceEl || !targetEl) continue;

      const sourceRect = sourceEl.getBoundingClientRect();
      const targetRect = targetEl.getBoundingClientRect();

      next.push({
        id: `${edge.id}`,
        x1: sourceRect.left + sourceRect.width / 2 - canvasRect.left + canvasEl.scrollLeft,
        y1: sourceRect.top + sourceRect.height / 2 - canvasRect.top + canvasEl.scrollTop,
        x2: targetRect.left + targetRect.width / 2 - canvasRect.left + canvasEl.scrollLeft,
        y2: targetRect.top + targetRect.height / 2 - canvasRect.top + canvasEl.scrollTop,
      });
    }
    setLines(next);
  }, [edges, nodes, allSlots, racks]);

  return (
    <svg className="cable-overlay">
      {lines.map((line) => (
        <line key={line.id} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} className="cable-overlay-line" />
      ))}
    </svg>
  );
}
