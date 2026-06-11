import React, { memo } from 'react';
import { NodeResizer } from 'reactflow';
import './ZoneNode.css';

export const ZONE_COLORS = {
  blue: { fill: 'rgba(37, 99, 235, 0.08)', border: 'rgba(37, 99, 235, 0.5)' },
  green: { fill: 'rgba(22, 163, 74, 0.08)', border: 'rgba(22, 163, 74, 0.5)' },
  red: { fill: 'rgba(220, 38, 38, 0.08)', border: 'rgba(220, 38, 38, 0.5)' },
  orange: { fill: 'rgba(217, 119, 6, 0.08)', border: 'rgba(217, 119, 6, 0.5)' },
  purple: { fill: 'rgba(124, 58, 237, 0.08)', border: 'rgba(124, 58, 237, 0.5)' },
  gray: { fill: 'rgba(107, 114, 128, 0.08)', border: 'rgba(107, 114, 128, 0.5)' },
};

function ZoneNode({ id, data, selected }) {
  const palette = ZONE_COLORS[data.color] || ZONE_COLORS.blue;
  const borderStyle = data.border_style === 'dotted' ? 'dotted' : 'solid';

  return (
    <div
      className="zone-node"
      style={{
        background: palette.fill,
        border: `2px ${borderStyle} ${palette.border}`,
      }}
    >
      <NodeResizer
        color={palette.border}
        isVisible={selected}
        minWidth={120}
        minHeight={80}
        onResizeEnd={(_event, params) => data.onResizeEnd?.(id, params)}
      />
      <div className="zone-label" style={{ color: palette.border }}>
        {data.name}
      </div>
      {selected && (
        <button className="zone-delete" onClick={() => data.onDelete?.(id)} aria-label="Delete zone">
          &times;
        </button>
      )}
    </div>
  );
}

export default memo(ZoneNode);
