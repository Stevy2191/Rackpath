import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';
import './DeviceNode.css';

const ICONS = {
  router: '🌐',
  switch: '🔀',
  server: '🖥️',
  unknown: '❔',
};

export function classifyDevice(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('router') || t.includes('gateway') || t.includes('firewall')) return 'router';
  if (t.includes('switch')) return 'switch';
  if (t.includes('server') || t.includes('linux') || t.includes('windows') || t.includes('unix')) return 'server';
  return 'unknown';
}

function DeviceNode({ data }) {
  const kind = classifyDevice(data.type);

  return (
    <div className={`device-node device-node-${kind}`}>
      <Handle type="target" position={Position.Top} />
      <Handle type="target" position={Position.Left} id="left" />
      <div className="device-node-icon" aria-hidden="true">{ICONS[kind]}</div>
      <div className="device-node-body">
        <div className="device-node-label">{data.label}</div>
        {data.ip && <div className="device-node-ip">{data.ip}</div>}
      </div>
      <Handle type="source" position={Position.Bottom} />
      <Handle type="source" position={Position.Right} id="right" />
    </div>
  );
}

export default memo(DeviceNode);
