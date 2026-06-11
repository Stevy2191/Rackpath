import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { DEVICE_TYPES, classifyDevice, isCustomType, customIconFilename, customIconUrl } from './topology/deviceTypes';
import './DeviceNode.css';

const HANDLES = [
  { id: 'top', position: Position.Top },
  { id: 'right', position: Position.Right },
  { id: 'bottom', position: Position.Bottom },
  { id: 'left', position: Position.Left },
];

function DeviceNode({ data }) {
  const kind = classifyDevice(data.type);
  const info = DEVICE_TYPES[kind];

  return (
    <div className="device-node" style={{ borderColor: info.color }}>
      {HANDLES.map((handle) => (
        <Handle
          key={handle.id}
          id={handle.id}
          type="source"
          position={handle.position}
          className="device-node-handle"
        />
      ))}
      <div className="device-node-icon" style={{ color: info.color }} aria-hidden="true">
        {isCustomType(data.type) ? (
          <img className="device-node-custom-icon" src={customIconUrl(customIconFilename(data.type))} alt="" />
        ) : (
          info.icon
        )}
      </div>
      <div className="device-node-body">
        <div className="device-node-label">{data.hostname || data.ip || `Device ${data.id}`}</div>
        {data.ip && <div className="device-node-ip">{data.ip}</div>}
      </div>
    </div>
  );
}

export default memo(DeviceNode);
