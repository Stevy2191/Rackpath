import React, { useState, useEffect } from 'react';
import { X, Copy, Download, Trash2 } from 'lucide-react';
import './RackEditPanel.css';

const RACK_TYPES = [
  { value: '4-post',          label: '4-Post Rack' },
  { value: '2-post',          label: '2-Post Rack' },
  { value: 'wall-mount',      label: 'Wall Mount' },
  { value: 'open-frame',      label: 'Open Frame' },
  { value: 'blade-enclosure', label: 'Blade Enclosure' },
];

const WIDTH_OPTIONS = [
  { value: '10"', label: '10"', sub: 'Compact' },
  { value: '19"', label: '19"', sub: 'Standard' },
  { value: '21"', label: '21"', sub: 'Wide' },
  { value: '23"', label: '23"', sub: 'Telco' },
];

const HEIGHT_PRESETS = [8, 12, 16, 24, 32, 42, 47];

const ANNOTATION_FIELDS = [
  { value: 'none',         label: 'None' },
  { value: 'name',         label: 'Name' },
  { value: 'ip_address',   label: 'IP Address' },
  { value: 'notes',        label: 'Notes' },
  { value: 'asset_tag',    label: 'Asset Tag' },
  { value: 'serial',       label: 'Serial Number' },
  { value: 'manufacturer', label: 'Manufacturer' },
];

export default function RackEditPanel({ rack, usedU = 0, onClose, onSave, onDuplicate, onDelete, onExport, onExportJson }) {
  const [edits, setEdits] = useState({
    name:             rack.name,
    location:         rack.location         || '',
    u_height:         rack.u_height,
    rack_width:       rack.rack_width        || '19"',
    rack_type:        rack.rack_type         || '4-post',
    notes:            rack.notes             || '',
    show_rear:        rack.show_rear !== undefined ? rack.show_rear : 1,
    annotation_field: rack.annotation_field  || 'none',
  });

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEdits({
      name:             rack.name,
      location:         rack.location         || '',
      u_height:         rack.u_height,
      rack_width:       rack.rack_width        || '19"',
      rack_type:        rack.rack_type         || '4-post',
      notes:            rack.notes             || '',
      show_rear:        rack.show_rear !== undefined ? rack.show_rear : 1,
      annotation_field: rack.annotation_field  || 'none',
    });
  }, [rack.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    await onSave(edits);
    setSaving(false);
  };

  const handleDelete = () => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete "${rack.name}" and all its slots? This cannot be undone.`)) return;
    onDelete();
  };

  const wontFit = usedU > edits.u_height;

  return (
    <div className="rack-edit-panel">
      <div className="rack-edit-panel-header">
        <span className="rack-edit-panel-title">{rack.name}</span>
        <button type="button" className="rack-edit-panel-close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      <div className="rack-edit-panel-body">
        <form onSubmit={handleSave}>
          <div className="rep-field">
            <label className="rep-label">NAME</label>
            <input
              className="rep-input"
              value={edits.name}
              onChange={(e) => setEdits({ ...edits, name: e.target.value })}
              required
            />
          </div>

          <div className="rep-field">
            <label className="rep-label">LOCATION</label>
            <input
              className="rep-input"
              value={edits.location}
              onChange={(e) => setEdits({ ...edits, location: e.target.value })}
              placeholder="e.g. DC1 Row 3"
            />
          </div>

          <div className="rep-field">
            <label className="rep-label">WIDTH</label>
            <div className="rep-width-cards">
              {WIDTH_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`rep-width-card${edits.rack_width === opt.value ? ' selected' : ''}`}
                  onClick={() => setEdits({ ...edits, rack_width: opt.value })}
                >
                  <span className="rep-width-label">{opt.label}</span>
                  <span className="rep-width-sub">{opt.sub}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="rep-field">
            <label className="rep-label">HEIGHT</label>
            <div className="rep-u-usage">{usedU} of {rack.u_height}U used</div>
            <div className="rep-height-presets">
              {HEIGHT_PRESETS.map((h) => (
                <button
                  key={h}
                  type="button"
                  className={`rep-preset-btn${edits.u_height === h ? ' selected' : ''}`}
                  onClick={() => setEdits({ ...edits, u_height: h })}
                >
                  {h}U
                </button>
              ))}
            </div>
            <div className="rep-slider-row">
              <input
                type="range"
                min={1}
                max={100}
                value={edits.u_height}
                onChange={(e) => setEdits({ ...edits, u_height: Number(e.target.value) })}
              />
              <span className="rep-slider-val">{edits.u_height}U</span>
            </div>
            {wontFit && (
              <div className="rep-warning">
                Cannot resize: {usedU}U of devices installed, but {edits.u_height}U rack selected.
                Remove {usedU - edits.u_height}U of equipment first.
              </div>
            )}
          </div>

          <div className="rep-field">
            <label className="rep-label">RACK TYPE</label>
            <select
              className="rep-input"
              value={edits.rack_type}
              onChange={(e) => setEdits({ ...edits, rack_type: e.target.value })}
            >
              {RACK_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          <div className="rep-field">
            <label className="rep-label">NOTES</label>
            <textarea
              className="rep-input rep-textarea"
              value={edits.notes}
              onChange={(e) => setEdits({ ...edits, notes: e.target.value })}
              rows={3}
            />
          </div>

          <div className="rep-field">
            <span className="rep-label">REAR VIEW</span>
            <label className="rep-toggle">
              <input
                type="checkbox"
                checked={Boolean(edits.show_rear)}
                onChange={(e) => setEdits({ ...edits, show_rear: e.target.checked ? 1 : 0 })}
              />
              Show rear panel
            </label>
          </div>

          <div className="rep-field rep-field-section-start">
            <label className="rep-label">ANNOTATION FIELD</label>
            <select
              className="rep-input"
              value={edits.annotation_field}
              onChange={(e) => setEdits({ ...edits, annotation_field: e.target.value })}
            >
              {ANNOTATION_FIELDS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>

          <button type="submit" className="rep-save-btn" disabled={saving || wontFit}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </form>

        <div className="rep-actions">
          <button type="button" className="rep-action-btn" onClick={onDuplicate}>
            <Copy size={13} /> Duplicate Rack
          </button>
          <button type="button" className="rep-action-btn" onClick={onExport}>
            <Download size={13} /> Export…
          </button>
          {onExportJson && (
            <button type="button" className="rep-action-btn" onClick={onExportJson}>
              <Download size={13} /> JSON Backup
            </button>
          )}
          <button type="button" className="rep-action-btn rep-action-danger" onClick={handleDelete}>
            <Trash2 size={13} /> Delete Rack
          </button>
        </div>
      </div>
    </div>
  );
}
