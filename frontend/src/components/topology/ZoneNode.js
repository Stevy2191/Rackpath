import React, { memo, useEffect, useRef, useState } from 'react';
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

const COLOR_KEYS = Object.keys(ZONE_COLORS);

function ZoneNode({ id, data, selected }) {
  const palette = ZONE_COLORS[data.color] || ZONE_COLORS.blue;
  const borderStyle = data.border_style === 'dotted' ? 'dotted' : 'solid';

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(data.name || '');
  const inputRef = useRef(null);

  useEffect(() => {
    setValue(data.name || '');
  }, [data.name]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  // Open the editor on double-click anywhere on the zone, in any toolbar mode.
  // Stop propagation so React Flow's pane double-click (zoom) never fires.
  const openEditor = (e) => {
    e.stopPropagation();
    setEditing(true);
  };

  const commitName = () => {
    const next = value.trim();
    if (next !== (data.name || '')) data.onUpdate?.(id, { name: next });
  };

  const stop = (e) => e.stopPropagation();

  return (
    <div
      className="zone-node"
      style={{
        background: palette.fill,
        border: `2px ${borderStyle} ${palette.border}`,
      }}
      onDoubleClick={openEditor}
    >
      <NodeResizer
        color={palette.border}
        isVisible={selected}
        minWidth={120}
        minHeight={80}
        onResizeEnd={(_event, params) => data.onResizeEnd?.(id, params)}
      />

      {editing ? (
        <div className="zone-editor nodrag nopan" onMouseDown={stop} onClick={stop} onDoubleClick={stop}>
          <input
            ref={inputRef}
            className="zone-editor-name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.target.blur();
              if (e.key === 'Escape') {
                setValue(data.name || '');
                setEditing(false);
              }
            }}
            placeholder="Zone name"
          />
          <div className="zone-editor-colors">
            {COLOR_KEYS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                title={c}
                className={`zone-editor-swatch${data.color === c ? ' selected' : ''}`}
                style={{ background: ZONE_COLORS[c].border }}
                onClick={() => data.onUpdate?.(id, { color: c })}
              />
            ))}
          </div>
          <div className="zone-editor-actions">
            <select
              className="zone-editor-border"
              value={borderStyle}
              onChange={(e) => data.onUpdate?.(id, { border_style: e.target.value })}
            >
              <option value="solid">Solid</option>
              <option value="dotted">Dotted</option>
            </select>
            <button type="button" className="zone-editor-done" onClick={() => setEditing(false)}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="zone-label" style={{ color: palette.border }} title="Double-click to edit">
          {data.name || 'Zone'}
        </div>
      )}

      {selected && !editing && (
        <button className="zone-delete" onClick={() => data.onDelete?.(id)} aria-label="Delete zone">
          &times;
        </button>
      )}
    </div>
  );
}

export default memo(ZoneNode);
