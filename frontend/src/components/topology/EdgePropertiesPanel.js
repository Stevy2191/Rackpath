import React from 'react';
import { X, Cable, Waves, Spline, Wifi, Eye, EyeOff } from 'lucide-react';
import { COLOR_SWATCHES } from './deviceTypes';
import './EdgePropertiesPanel.css';

const CABLE_TYPES = [
  { value: 'Copper (Cat6)', label: 'Copper Cat6', icon: Cable },
  { value: 'Multi-Mode Fibre', label: 'Multi-Mode Fibre', icon: Waves },
  { value: 'Single-Mode Fibre', label: 'Single-Mode Fibre', icon: Spline },
  { value: 'Wireless Link', label: 'Wireless Link', icon: Wifi },
];

const LINE_STYLES = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'animated', label: 'Animated' },
];

// DB booleans round-trip as 0/1; treat anything falsy other than
// undefined/null (the "unset, default visible" case) as hidden.
function isVisible(value) {
  return !(value === false || value === 0 || value === '0');
}

export default function EdgePropertiesPanel({ edge, sourceHostname, targetHostname, onClose, onUpdate, onDelete, onCopy, onPaste }) {
  if (!edge) return <aside className="edge-properties-panel" />;

  const data = edge.data || {};
  const edgeDbId = Number(edge.id.replace('edge-', ''));
  const cableTypeMeta = CABLE_TYPES.find((c) => c.value === data.cable_type);
  const TypeIcon = cableTypeMeta?.icon || Cable;

  return (
    <aside className="edge-properties-panel open">
      <div className="edge-properties-header">
        <span className="edge-properties-icon">
          <TypeIcon size={20} strokeWidth={2} />
        </span>
        <select
          className="edge-properties-type-select"
          value={data.cable_type || ''}
          onChange={(e) => onUpdate(edgeDbId, { cable_type: e.target.value || null })}
        >
          <option value="">Generic Link</option>
          {CABLE_TYPES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <button className="edge-properties-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <div className="edge-properties-section">
        <span className="edge-properties-label">Source</span>
        <input className="edge-properties-input" value={sourceHostname || ''} readOnly />
      </div>

      <div className="edge-properties-section">
        <span className="edge-properties-label">Target</span>
        <input className="edge-properties-input" value={targetHostname || ''} readOnly />
      </div>

      <div className="edge-properties-section">
        <span className="edge-properties-label">Interface Labels</span>
        <div className="edge-properties-toggle-row">
          <button
            type="button"
            className={`edge-properties-toggle${isVisible(data.source_label_visible) ? ' active' : ''}`}
            onClick={() => onUpdate(edgeDbId, { source_label_visible: !isVisible(data.source_label_visible) })}
          >
            Source
          </button>
          <button
            type="button"
            className={`edge-properties-toggle${isVisible(data.target_label_visible) ? ' active' : ''}`}
            onClick={() => onUpdate(edgeDbId, { target_label_visible: !isVisible(data.target_label_visible) })}
          >
            Target
          </button>
        </div>
      </div>

      <div className="edge-properties-section">
        <span className="edge-properties-label">Label Color</span>
        <div className="edge-properties-swatch-row">
          <div className="edge-properties-swatches">
            {COLOR_SWATCHES.map((c) => (
              <button
                key={c.name}
                type="button"
                aria-label={c.name}
                title={c.name}
                className={`edge-properties-swatch${data.label_color === c.hex ? ' selected' : ''}`}
                style={{ background: c.hex }}
                onClick={() => onUpdate(edgeDbId, { label_color: c.hex })}
              />
            ))}
          </div>
          <button type="button" className="edge-properties-reset" onClick={() => onUpdate(edgeDbId, { label_color: null })}>
            Reset Label Color
          </button>
        </div>
      </div>

      <div className="edge-properties-section">
        <span className="edge-properties-label">Line Style</span>
        <div className="edge-properties-segmented">
          {LINE_STYLES.map((s) => (
            <button
              key={s.value}
              type="button"
              className={`edge-properties-segment${(data.line_style || 'solid') === s.value ? ' active' : ''}`}
              onClick={() => onUpdate(edgeDbId, { line_style: s.value })}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="edge-properties-section">
        <button
          type="button"
          className={`edge-properties-eye-toggle${data.snapping ? ' active' : ''}`}
          onClick={() => onUpdate(edgeDbId, { snapping: !data.snapping })}
        >
          {data.snapping ? <Eye size={16} /> : <EyeOff size={16} />}
          Link Snapping
        </button>
      </div>

      <div className="edge-properties-section edge-properties-actions">
        <div className="edge-properties-actions-row">
          <button type="button" className="edge-properties-action-btn" onClick={() => onCopy(edge)}>
            Copy
          </button>
          <button type="button" className="edge-properties-action-btn" onClick={() => onPaste(edgeDbId)}>
            Paste
          </button>
        </div>
        <button type="button" className="edge-properties-action-btn edge-properties-delete" onClick={() => onDelete(edge.id)}>
          Delete
        </button>
      </div>
    </aside>
  );
}
