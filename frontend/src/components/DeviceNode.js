import React, { memo } from 'react';
import { Handle, NodeResizer, Position } from 'reactflow';
import { DEVICE_TYPES, classifyDevice, isCustomType, customIconFilename, customIconUrl } from './topology/deviceTypes';
import './DeviceNode.css';

const HANDLES = [
  { id: 'top', position: Position.Top },
  { id: 'right', position: Position.Right },
  { id: 'bottom', position: Position.Bottom },
  { id: 'left', position: Position.Left },
];

function DeviceNode({ id, data, selected }) {
  const kind = classifyDevice(data.type);
  const info = DEVICE_TYPES[kind];
  const Icon = info.icon;
  const iconColor = data.icon_color || info.color;
  const textColor = data.text_color || 'var(--color-text)';

  return (
    <div className="device-node" style={{ borderColor: selected ? 'var(--color-accent)' : undefined }}>
      <NodeResizer
        color={info.color}
        isVisible={selected}
        minWidth={40}
        minHeight={40}
        onResizeEnd={(_event, params) => data.onResizeEnd?.(id, params)}
      />
      {HANDLES.map((handle) => (
        // Pair a target handle with each source handle (same id) so React
        // Flow always has a fresh drop target registered at this point,
        // even right after a previous edge using it was deleted.
        <React.Fragment key={handle.id}>
          <Handle
            id={handle.id}
            type="target"
            position={handle.position}
            className="device-node-handle device-node-handle-target"
          />
          <Handle
            id={handle.id}
            type="source"
            position={handle.position}
            className="device-node-handle device-node-handle-source"
          />
        </React.Fragment>
      ))}
      <div className="device-node-icon" style={{ color: iconColor }} aria-hidden="true">
        {isCustomType(data.type) ? (
          <img className="device-node-custom-icon" src={customIconUrl(customIconFilename(data.type))} alt="" />
        ) : (
          <Icon size={22} strokeWidth={2} />
        )}
      </div>
      <div className="device-node-caption" style={{ color: textColor }}>
        {data.hostname || data.ip || `Device ${data.id}`}
      </div>
    </div>
  );
}

export default memo(DeviceNode);
