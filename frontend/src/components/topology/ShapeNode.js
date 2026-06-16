import React, { memo, useEffect, useRef, useState } from 'react';
import { NodeResizer } from 'reactflow';
import './ShapeNode.css';

export const SHAPE_TYPES = [
  { id: 'rect',        label: 'Rectangle' },
  { id: 'circle',      label: 'Circle'    },
  { id: 'diamond',     label: 'Diamond'   },
  { id: 'hexagon',     label: 'Hexagon'   },
  { id: 'cylinder',    label: 'Cylinder'  },
  { id: 'parallelogram', label: 'Parallelogram' },
];

const PRESET_COLORS = [
  { fill: '#3b82f620', border: '#3b82f6' },
  { fill: '#22c55e20', border: '#22c55e' },
  { fill: '#ef444420', border: '#ef4444' },
  { fill: '#f59e0b20', border: '#f59e0b' },
  { fill: '#8b5cf620', border: '#8b5cf6' },
  { fill: '#6b728020', border: '#6b7280' },
];

function ShapeSvg({ type, fill, stroke, width, height }) {
  const sw = 2;
  switch (type) {
    case 'circle':
      return (
        <svg width={width} height={height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          <ellipse
            cx={width / 2} cy={height / 2}
            rx={Math.max(1, width / 2 - sw / 2)} ry={Math.max(1, height / 2 - sw / 2)}
            fill={fill} stroke={stroke} strokeWidth={sw}
          />
        </svg>
      );
    case 'diamond': {
      const w = width, h = height;
      const pts = `${w / 2},${sw} ${w - sw},${h / 2} ${w / 2},${h - sw} ${sw},${h / 2}`;
      return (
        <svg width={width} height={height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          <polygon points={pts} fill={fill} stroke={stroke} strokeWidth={sw} />
        </svg>
      );
    }
    case 'hexagon': {
      const cx = width / 2, cy = height / 2;
      const rx = width / 2 - sw, ry = height / 2 - sw;
      const pts = [0, 1, 2, 3, 4, 5]
        .map((i) => {
          const a = (Math.PI / 180) * (60 * i - 30);
          return `${cx + rx * Math.cos(a)},${cy + ry * Math.sin(a)}`;
        })
        .join(' ');
      return (
        <svg width={width} height={height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          <polygon points={pts} fill={fill} stroke={stroke} strokeWidth={sw} />
        </svg>
      );
    }
    case 'cylinder': {
      const rx = width / 2 - sw, ry = Math.min(20, height * 0.18);
      const top = sw + ry, bot = height - sw - ry;
      return (
        <svg width={width} height={height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          <rect x={sw} y={top} width={width - sw * 2} height={bot - top} fill={fill} stroke="none" />
          <path
            d={`M ${sw},${top} Q ${sw},${sw} ${width / 2},${sw} Q ${width - sw},${sw} ${width - sw},${top}
                L ${width - sw},${bot} Q ${width - sw},${height - sw} ${width / 2},${height - sw}
                Q ${sw},${height - sw} ${sw},${bot} Z`}
            fill={fill} stroke={stroke} strokeWidth={sw}
          />
          <ellipse cx={width / 2} cy={top} rx={rx} ry={ry} fill={fill} stroke={stroke} strokeWidth={sw} />
        </svg>
      );
    }
    case 'parallelogram': {
      const skew = Math.min(24, width * 0.15);
      const pts = `${skew},${sw} ${width - sw},${sw} ${width - skew},${height - sw} ${sw},${height - sw}`;
      return (
        <svg width={width} height={height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          <polygon points={pts} fill={fill} stroke={stroke} strokeWidth={sw} />
        </svg>
      );
    }
    default: // rect
      return (
        <svg width={width} height={height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          <rect x={sw / 2} y={sw / 2} width={width - sw} height={height - sw}
            fill={fill} stroke={stroke} strokeWidth={sw} rx={4} />
        </svg>
      );
  }
}

function ShapeNode({ id, data, selected }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(data.label || '');
  const [fill, setFill] = useState(data.fill_color || '#3b82f620');
  const [border, setBorder] = useState(data.border_color || '#3b82f6');
  const inputRef = useRef(null);
  const [dims, setDims] = useState({ width: 160, height: 100 });
  const wrapRef = useRef(null);

  useEffect(() => { setLabel(data.label || ''); }, [data.label]);
  useEffect(() => { setFill(data.fill_color || '#3b82f620'); }, [data.fill_color]);
  useEffect(() => { setBorder(data.border_color || '#3b82f6'); }, [data.border_color]);

  useEffect(() => {
    if (!wrapRef.current) return;
    const obs = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setDims({ width, height });
    });
    obs.observe(wrapRef.current);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    const nextLabel = label.trim() || null;
    const nextFill = fill;
    const nextBorder = border;
    if (nextLabel !== (data.label || null) || nextFill !== data.fill_color || nextBorder !== data.border_color) {
      data.onUpdate?.(id, { label: nextLabel, fill_color: nextFill, border_color: nextBorder });
    }
  };

  const stop = (e) => e.stopPropagation();

  return (
    <div ref={wrapRef} className="shape-node" onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}>
      <NodeResizer
        color={border}
        isVisible={selected}
        minWidth={60}
        minHeight={40}
        onResizeEnd={(_e, params) => data.onResizeEnd?.(id, params)}
      />

      <ShapeSvg
        type={data.shape_type || 'rect'}
        fill={fill}
        stroke={border}
        width={dims.width}
        height={dims.height}
      />

      {label && !editing && (
        <div className="shape-node-label" style={{ color: border }} title="Double-click to edit">
          {label}
        </div>
      )}

      {editing && (
        <div className="shape-node-editor nodrag nopan" onMouseDown={stop} onClick={stop} onDoubleClick={stop}>
          <input
            ref={inputRef}
            className="shape-node-editor-input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional)"
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.target.blur();
              if (e.key === 'Escape') { setLabel(data.label || ''); setEditing(false); }
            }}
            onBlur={commit}
          />
          <div className="shape-node-editor-colors">
            {PRESET_COLORS.map((c, i) => (
              <button
                key={i}
                type="button"
                className={`shape-node-swatch${border === c.border ? ' selected' : ''}`}
                style={{ background: c.border }}
                onClick={() => { setFill(c.fill); setBorder(c.border); }}
                aria-label={`Color ${i + 1}`}
              />
            ))}
          </div>
          <button type="button" className="shape-node-editor-done" onClick={() => { commit(); setEditing(false); }}>
            Done
          </button>
        </div>
      )}

      {selected && !editing && (
        <button className="shape-node-delete" onClick={() => data.onDelete?.(id)} aria-label="Delete shape">
          &times;
        </button>
      )}
    </div>
  );
}

export default memo(ShapeNode);
