import React, { useState, useEffect, useRef } from 'react';
import { useTopologyGraph } from '../TopologyGraphContext';

const ZONE_COLORS = {
  blue:   { fill: 'rgba(37, 99, 235, 0.08)',  border: 'rgba(37, 99, 235, 0.5)'  },
  green:  { fill: 'rgba(22, 163, 74, 0.08)',  border: 'rgba(22, 163, 74, 0.5)'  },
  red:    { fill: 'rgba(220, 38, 38, 0.08)',  border: 'rgba(220, 38, 38, 0.5)'  },
  orange: { fill: 'rgba(217, 119, 6, 0.08)',  border: 'rgba(217, 119, 6, 0.5)'  },
  purple: { fill: 'rgba(124, 58, 237, 0.08)', border: 'rgba(124, 58, 237, 0.5)' },
  gray:   { fill: 'rgba(107, 114, 128, 0.08)', border: 'rgba(107, 114, 128, 0.5)' },
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

export default function ZoneCell({ node }) {
  const { onZoneUpdate, onZoneDelete, vlans } = useTopologyGraph();
  const [, forceUpdate] = useState(0);
  const [editing, setEditing] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    const refresh = () => forceUpdate((n) => n + 1);
    node.on('change:data', refresh);
    return () => node.off('change:data', refresh);
  }, [node]);

  // Listen for external open-editor signal set by X6Canvas on dblclick
  useEffect(() => {
    const openEditor = () => {
      const d = node.getData() || {};
      setNameValue(d.name || '');
      setEditing(true);
    };
    node.on('zone:edit', openEditor);
    return () => node.off('zone:edit', openEditor);
  }, [node]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const data = node.getData() || {};
  const vlan = data.vlan_id != null ? (vlans || []).find((v) => v.id === data.vlan_id) : null;
  const palette = ZONE_COLORS[data.color] || ZONE_COLORS.blue;
  const vlanFill = vlan ? hexToRgba(vlan.color, 0.3) : null;
  const vlanBorder = vlan ? hexToRgba(vlan.color, 0.65) : null;
  const activePalette = vlan && vlanFill && vlanBorder ? { fill: vlanFill, border: vlanBorder } : palette;
  const borderStyle = data.border_style === 'dotted' ? 'dotted' : 'solid';

  const commitName = () => {
    const next = nameValue.trim();
    if (next !== (data.name || '')) {
      onZoneUpdate(data.id, { name: next });
      node.setData({ name: next });
    }
    setEditing(false);
  };

  const stop = (e) => e.stopPropagation();

  return (
    <div
      className="x6-zone-cell"
      style={{
        background: activePalette.fill,
        border: `2px ${borderStyle} ${activePalette.border}`,
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        borderRadius: 4,
        position: 'relative',
        overflow: 'visible',
      }}
    >
      {editing ? (
        <div
          className="x6-zone-editor"
          onMouseDown={stop}
          onClick={stop}
          onDoubleClick={stop}
        >
          <input
            ref={inputRef}
            className="x6-zone-editor-name"
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitName();
              if (e.key === 'Escape') { setNameValue(data.name || ''); setEditing(false); }
            }}
            placeholder="Zone name"
          />
          <div className="x6-zone-editor-colors">
            {COLOR_KEYS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                title={c}
                className={`x6-zone-swatch${data.color === c && !data.vlan_id ? ' selected' : ''}`}
                style={{ background: ZONE_COLORS[c].border }}
                onClick={() => {
                  const patch = { color: c };
                  if (data.vlan_id != null) patch.vlan_id = null;
                  onZoneUpdate(data.id, patch);
                  node.setData(patch);
                }}
              />
            ))}
          </div>
          <select
            className="x6-zone-editor-vlan"
            value={data.vlan_id ?? ''}
            onChange={(e) => {
              const patch = { vlan_id: e.target.value ? Number(e.target.value) : null };
              onZoneUpdate(data.id, patch);
              node.setData(patch);
            }}
          >
            <option value="">No VLAN</option>
            {(vlans || []).map((v) => (
              <option key={v.id} value={v.id}>VLAN {v.vlan_id} - {v.name}</option>
            ))}
          </select>
          <div className="x6-zone-editor-actions">
            <select
              className="x6-zone-editor-border"
              value={borderStyle}
              onChange={(e) => {
                const patch = { border_style: e.target.value };
                onZoneUpdate(data.id, patch);
                node.setData(patch);
              }}
            >
              <option value="solid">Solid</option>
              <option value="dotted">Dotted</option>
            </select>
            <button type="button" className="x6-zone-editor-done" onClick={() => setEditing(false)}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="x6-zone-label" style={{ color: activePalette.border }}>
          {vlan ? `VLAN ${vlan.vlan_id} · ${vlan.name}` : data.name || 'Zone'}
        </div>
      )}
      {!editing && (
        <button
          className="x6-zone-delete"
          onMouseDown={stop}
          onClick={(e) => { stop(e); onZoneDelete(node.id); }}
          aria-label="Delete zone"
        >
          &times;
        </button>
      )}
    </div>
  );
}
