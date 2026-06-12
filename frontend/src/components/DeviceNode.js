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

const POSITION_MAP = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

// Spread connection points that share a side so they don't stack on top of
// one another. Returns a percentage offset along that side.
function offsetForIndex(index, count) {
  return `${((index + 1) / (count + 1)) * 100}%`;
}

function ConnectionPointHandle({ point, index, count }) {
  const position = POSITION_MAP[point.position] || Position.Top;
  const along = offsetForIndex(index, count);
  const isHorizontal = point.position === 'top' || point.position === 'bottom';
  const style = isHorizontal ? { left: along } : { top: along };
  const labelClass = `device-node-cp-label device-node-cp-label-${point.position}`;

  return (
    <>
      <Handle
        id={`cp-${point.id}`}
        type="target"
        position={position}
        style={style}
        className="device-node-cp-handle device-node-cp-handle-target"
      />
      <Handle
        id={`cp-${point.id}`}
        type="source"
        position={position}
        style={style}
        className="device-node-cp-handle"
      />
      {point.name ? (
        <span className={labelClass} style={style}>
          {point.name}
        </span>
      ) : null}
    </>
  );
}

function DeviceNode({ id, data, selected }) {
  const kind = classifyDevice(data.type);
  const info = DEVICE_TYPES[kind];
  const Icon = info.icon;
  const iconColor = data.icon_color || info.color;
  const textColor = data.text_color || 'var(--color-text)';

  const mode = data.mode || 'select';
  const connectionPoints = data.connectionPoints || [];
  const fullLabel = data.hostname || data.ip || `Device ${data.id}`;

  // Group connection points by side so each side can spread its points evenly.
  const bySide = { top: [], right: [], bottom: [], left: [] };
  connectionPoints.forEach((cp) => {
    (bySide[cp.position] || bySide.top).push(cp);
  });

  const classNames = [
    'device-node',
    mode === 'link' ? 'is-link-mode' : '',
    data.isLinkSource ? 'is-link-source' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classNames} style={{ borderColor: selected ? 'var(--color-accent)' : undefined }}>
      <NodeResizer
        color={info.color}
        isVisible={selected && mode === 'select'}
        minWidth={40}
        minHeight={40}
        onResizeEnd={(_event, params) => data.onResizeEnd?.(id, params)}
      />

      {/* Directional anchor handles. Kept in the DOM so edges always have a
          point to attach to, but rendered with no visible dot. */}
      {HANDLES.map((handle) => (
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

      {/* Named connection points added via the properties panel. */}
      {Object.entries(bySide).flatMap(([side, points]) =>
        points.map((cp, i) => (
          <ConnectionPointHandle key={cp.id} point={cp} index={i} count={points.length} />
        ))
      )}

      {/* Single centre handle shown only while hovering in Link mode. */}
      <span className="device-node-link-dot" aria-hidden="true" />

      <div className="device-node-icon" style={{ color: iconColor }} aria-hidden="true">
        {isCustomType(data.type) ? (
          <img className="device-node-custom-icon" src={customIconUrl(customIconFilename(data.type))} alt="" />
        ) : (
          <Icon size={22} strokeWidth={2} />
        )}
      </div>
      <div className="device-node-caption" style={{ color: textColor }} title={fullLabel}>
        {fullLabel}
      </div>
    </div>
  );
}

export default memo(DeviceNode);
