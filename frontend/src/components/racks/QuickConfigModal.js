import React, { useState } from 'react';
import { COLOR_SWATCHES, getFieldSchema, normalizeCatalogEntry } from './deviceFieldSchemas';
import DeviceConfigFields from './DeviceConfigFields';
import './DevicePropertiesPanel.css';

// Quick-config step shown before placing a generic catalog entry or a saved
// custom catalog entry. Pre-filled with the entry's defaults so confirming
// immediately ("Place") just works for users who don't need to change
// anything; everything here stays editable later in the properties panel.
export default function QuickConfigModal({ pending, onConfirm, onCancel }) {
  const { entry, source } = pending;
  const [fields, setFields] = useState(() => normalizeCatalogEntry(entry, source));

  const schema = getFieldSchema(fields.render_type);
  const set = (key, val) => setFields((f) => ({ ...f, [key]: val }));

  const handleSubmit = (e) => {
    e.preventDefault();
    onConfirm(fields);
  };

  return (
    <div className="rack-modal-overlay" onMouseDown={onCancel}>
      <div className="rack-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Place "{entry.name}"</h3>
        <form onSubmit={handleSubmit}>
          <label>
            Label
            <input
              value={fields.label}
              onChange={(e) => set('label', e.target.value)}
              placeholder="Device name"
              autoFocus
              required
            />
          </label>
          <label>
            Height (U)
            <input
              type="number"
              min="1"
              max="60"
              value={fields.u_size}
              onChange={(e) => set('u_size', Math.max(1, Number(e.target.value) || 1))}
            />
          </label>

          <div className="props-field">
            <label className="props-field-label">Color</label>
            <div className="props-swatches">
              {COLOR_SWATCHES.map((c, i) => (
                <button
                  key={i}
                  type="button"
                  className={`props-swatch${fields.color === c ? ' active' : ''}`}
                  style={c ? { background: c } : {}}
                  title={c || 'None'}
                  onClick={() => set('color', c)}
                >
                  {!c && '✕'}
                </button>
              ))}
            </div>
          </div>

          <div className="props-field">
            <label className="props-field-label">Width</label>
            <div className="props-face-btns">
              <button type="button" className={`props-face-btn${fields.slot_width === 'full' ? ' active' : ''}`} onClick={() => set('slot_width', 'full')}>Full</button>
              <button type="button" className={`props-face-btn${fields.slot_width === 'half-width' ? ' active' : ''}`} onClick={() => set('slot_width', 'half-width')}>Half</button>
              <button type="button" className={`props-face-btn${fields.slot_width === 'third' ? ' active' : ''}`} onClick={() => set('slot_width', 'third')}>Third</button>
            </div>
          </div>

          <div className="props-field">
            <label className="props-field-label">Depth</label>
            <div className="props-face-btns">
              <button type="button" className={`props-face-btn${!fields.half_depth ? ' active' : ''}`} onClick={() => set('half_depth', false)}>Full</button>
              <button type="button" className={`props-face-btn${fields.half_depth ? ' active' : ''}`} onClick={() => set('half_depth', true)}>Half</button>
            </div>
          </div>

          <DeviceConfigFields schema={schema} values={fields} onChange={set} />

          <div className="rack-modal-actions">
            <button type="button" onClick={onCancel}>Cancel</button>
            <button type="submit" className="rack-modal-save">Place</button>
          </div>
        </form>
      </div>
    </div>
  );
}
