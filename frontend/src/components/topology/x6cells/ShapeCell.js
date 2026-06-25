import React, { useState, useEffect, useRef } from 'react';
import { useTopologyGraph } from '../TopologyGraphContext';

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
  const w = width || 160;
  const h = height || 100;
  switch (type) {
    case 'circle':
      return (
        <svg width={w} height={h} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          <ellipse cx={w/2} cy={h/2} rx={Math.max(1, w/2 - sw/2)} ry={Math.max(1, h/2 - sw/2)} fill={fill} stroke={stroke} strokeWidth={sw} />
        </svg>
      );
    case 'diamond': {
      const pts = `${w/2},${sw} ${w-sw},${h/2} ${w/2},${h-sw} ${sw},${h/2}`;
      return (
        <svg width={w} height={h} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          <polygon points={pts} fill={fill} stroke={stroke} strokeWidth={sw} />
        </svg>
      );
    }
    case 'hexagon': {
      const cx = w/2, cy = h/2, rx = w/2 - sw, ry = h/2 - sw;
      const pts = [0,1,2,3,4,5].map((i) => {
        const a = (Math.PI / 180) * (60 * i - 30);
        return `${cx + rx * Math.cos(a)},${cy + ry * Math.sin(a)}`;
      }).join(' ');
      return (
        <svg width={w} height={h} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          <polygon points={pts} fill={fill} stroke={stroke} strokeWidth={sw} />
        </svg>
      );
    }
    case 'cylinder': {
      const rx = w/2 - sw, ry = Math.min(20, h * 0.18);
      const top = sw + ry, bot = h - sw - ry;
      return (
        <svg width={w} height={h} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          <rect x={sw} y={top} width={w - sw*2} height={bot - top} fill={fill} stroke="none" />
          <path
            d={`M ${sw},${top} Q ${sw},${sw} ${w/2},${sw} Q ${w-sw},${sw} ${w-sw},${top}
                L ${w-sw},${bot} Q ${w-sw},${h-sw} ${w/2},${h-sw}
                Q ${sw},${h-sw} ${sw},${bot} Z`}
            fill={fill} stroke={stroke} strokeWidth={sw}
          />
          <ellipse cx={w/2} cy={top} rx={rx} ry={ry} fill={fill} stroke={stroke} strokeWidth={sw} />
        </svg>
      );
    }
    case 'parallelogram': {
      const skew = Math.min(24, w * 0.15);
      const pts = `${skew},${sw} ${w-sw},${sw} ${w-skew},${h-sw} ${sw},${h-sw}`;
      return (
        <svg width={w} height={h} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          <polygon points={pts} fill={fill} stroke={stroke} strokeWidth={sw} />
        </svg>
      );
    }
    default:
      return (
        <svg width={w} height={h} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
          <rect x={sw/2} y={sw/2} width={w - sw} height={h - sw} fill={fill} stroke={stroke} strokeWidth={sw} rx={4} />
        </svg>
      );
  }
}

export default function ShapeCell({ node }) {
  const { onShapeUpdate, onShapeDelete } = useTopologyGraph();
  const [, forceUpdate] = useState(0);
  const [editing, setEditing] = useState(false);
  const [labelVal, setLabelVal] = useState('');
  const [fillVal, setFillVal] = useState('');
  const [borderVal, setBorderVal] = useState('');
  const [dims, setDims] = useState({ width: 160, height: 100 });
  const inputRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    const refresh = () => forceUpdate((n) => n + 1);
    node.on('change:data', refresh);
    return () => node.off('change:data', refresh);
  }, [node]);

  // Listen for open-editor signal from X6Canvas dblclick
  useEffect(() => {
    const openEditor = () => {
      const d = node.getData() || {};
      setLabelVal(d.label || '');
      setFillVal(d.fill_color || '#3b82f620');
      setBorderVal(d.border_color || '#3b82f6');
      setEditing(true);
    };
    node.on('shape:edit', openEditor);
    return () => node.off('shape:edit', openEditor);
  }, [node]);

  useEffect(() => {
    if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editing]);

  // Track container size for SVG scaling
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setDims({ width, height });
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  // Sync size from node changes too
  useEffect(() => {
    const onSizeChange = () => {
      const { width, height } = node.getSize();
      setDims({ width, height });
    };
    node.on('change:size', onSizeChange);
    return () => node.off('change:size', onSizeChange);
  }, [node]);

  const data = node.getData() || {};
  const fill = data.fill_color || '#3b82f620';
  const border = data.border_color || '#3b82f6';

  const commit = () => {
    const patch = {};
    if (labelVal.trim() !== (data.label || '')) patch.label = labelVal.trim() || null;
    if (fillVal !== data.fill_color) patch.fill_color = fillVal;
    if (borderVal !== data.border_color) patch.border_color = borderVal;
    if (Object.keys(patch).length > 0) {
      onShapeUpdate(data.id, patch);
      node.setData(patch);
    }
    setEditing(false);
  };

  const stop = (e) => e.stopPropagation();

  return (
    <div
      ref={containerRef}
      className="x6-shape-cell"
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      <ShapeSvg type={data.shape_type || 'rect'} fill={fill} stroke={border} width={dims.width} height={dims.height} />
      {data.label && !editing && (
        <div className="x6-shape-label" style={{ color: border }}>{data.label}</div>
      )}
      {editing && (
        <div className="x6-shape-editor" onMouseDown={stop} onClick={stop} onDoubleClick={stop}>
          <input
            ref={inputRef}
            className="x6-shape-editor-input"
            value={labelVal}
            onChange={(e) => setLabelVal(e.target.value)}
            placeholder="Label (optional)"
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') { setLabelVal(data.label || ''); setEditing(false); }
            }}
            onBlur={commit}
          />
          <div className="x6-shape-editor-colors">
            {PRESET_COLORS.map((c, i) => (
              <button
                key={i}
                type="button"
                className={`x6-shape-swatch${borderVal === c.border ? ' selected' : ''}`}
                style={{ background: c.border }}
                onClick={() => { setFillVal(c.fill); setBorderVal(c.border); }}
                aria-label={`Color ${i + 1}`}
              />
            ))}
          </div>
          <button type="button" className="x6-shape-editor-done" onClick={commit}>Done</button>
        </div>
      )}
      {!editing && (
        <button
          className="x6-shape-delete"
          onMouseDown={stop}
          onClick={(e) => { stop(e); onShapeDelete(node.id); }}
          aria-label="Delete shape"
        >
          &times;
        </button>
      )}
    </div>
  );
}
