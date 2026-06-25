import React, { useState, useEffect } from 'react';
import { useTopologyGraph } from '../TopologyGraphContext';
import { DEVICE_TYPES, classifyDevice, isCustomType, customIconFilename, customIconUrl } from '../deviceTypes';

// React component rendered inside X6 device nodes via @antv/x6-react-shape.
// Receives `node` (the X6 Node instance) as its only prop.
export default function DeviceCell({ node }) {
  const { onNodeDblClick, mode } = useTopologyGraph();
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const refresh = () => forceUpdate((n) => n + 1);
    node.on('change:data', refresh);
    return () => node.off('change:data', refresh);
  }, [node]);

  const data = node.getData() || {};
  const kind = classifyDevice(data.type);
  const info = DEVICE_TYPES[kind] || DEVICE_TYPES.unknown;
  const Icon = info.icon;
  const iconColor = data.icon_color || info.color;
  const textColor = data.text_color || 'var(--color-text)';
  const label = data.hostname || data.label || `Device ${data.id}`;

  const inLinkMode = mode === 'link';

  return (
    <div
      className={`x6-device-cell${inLinkMode ? ' x6-link-mode' : ''}`}
      title={label}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (data.deviceId) onNodeDblClick(data.deviceId);
      }}
    >
      <div className="x6-device-cell-icon" style={{ color: iconColor }}>
        {isCustomType(data.type) ? (
          <img
            className="x6-device-cell-custom-icon"
            src={customIconUrl(customIconFilename(data.type))}
            alt=""
          />
        ) : (
          <Icon size={22} strokeWidth={2} />
        )}
      </div>
      <div className="x6-device-cell-label" style={{ color: textColor }}>
        {label}
      </div>
    </div>
  );
}
