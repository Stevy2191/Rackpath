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

function hexToRgba(hex, alpha) {
  const clean = (hex || '').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16);
  if (Number.isNaN(num) || full.length !== 6) return null;
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function ZoneNode({ id, data, selected }) {
  const vlans = data.vlans || [];
  const vlan = data.vlan_id != null ? vlans.find((v) => v.id === data.vlan_id) : null;

  const colorPalette = ZONE_COLORS[data.color] || ZONE_COLORS.blue;
  const vlanFill = vlan ? hexToRgba(vlan.color, 0.3) : null;
  const vlanBorder = vlan ? hexToRgba(vlan.color, 0.65) : null;
  const palette = vlan && vlanFill && vlanBorder ? { fill: vlanFill, border: vlanBorder } : colorPalette;
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
                className={`zone-editor-swatch${data.color === c && !data.vlan_id ? ' selected' : ''}`}
                style={{ background: ZONE_COLORS[c].border }}
                onClick={() => {
                  const patch = { color: c };
                  if (data.vlan_id != null) patch.vlan_id = null;
                  data.onUpdate?.(id, patch);
                }}
              />
            ))}
          </div>
          <select
            className="zone-editor-vlan"
            value={data.vlan_id ?? ''}
            onChange={(e) => data.onUpdate?.(id, { vlan_id: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">No VLAN</option>
            {vlans.map((v) => (
              <option key={v.id} value={v.id}>
                VLAN {v.vlan_id} - {v.name}
              </option>
            ))}
          </select>
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
          {vlan ? `VLAN ${vlan.vlan_id} · ${vlan.name}` : data.name || 'Zone'}
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
