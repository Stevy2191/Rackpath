import React, { useState, useEffect } from 'react';
import { X, ChevronUp, ChevronDown, Copy, Download, FileDown, Trash2 } from 'lucide-react';
import './RackEditPanel.css';

const RACK_TYPES = [
  { value: '4-post',          label: '4-Post Rack' },
  { value: '2-post',          label: '2-Post Rack' },
  { value: 'wall-mount',      label: 'Wall Mount' },
  { value: 'open-frame',      label: 'Open Frame' },
  { value: 'blade-enclosure', label: 'Blade Enclosure' },
];

export default function RackEditPanel({ rack, onClose, onSave, onDuplicate, onDelete, onExport }) {
  const [edits, setEdits] = useState({
    name:      rack.name,
    location:  rack.location  || '',
    u_height:  rack.u_height,
    rack_type: rack.rack_type || '4-post',
    notes:     rack.notes     || '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEdits({
      name:      rack.name,
      location:  rack.location  || '',
      u_height:  rack.u_height,
      rack_type: rack.rack_type || '4-post',
      notes:     rack.notes     || '',
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
            <label className="rep-label">HEIGHT</label>
            <div className="rep-stepper">
              <button
                type="button"
                onClick={() => setEdits({ ...edits, u_height: Math.max(1, edits.u_height - 1) })}
                disabled={edits.u_height <= 1}
              >
                <ChevronDown size={13} />
              </button>
              <span className="rep-stepper-val">{edits.u_height}U</span>
              <button
                type="button"
                onClick={() => setEdits({ ...edits, u_height: Math.min(100, edits.u_height + 1) })}
                disabled={edits.u_height >= 100}
              >
                <ChevronUp size={13} />
              </button>
            </div>
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

          <button type="submit" className="rep-save-btn" disabled={saving}>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </form>

        <div className="rep-actions">
          <button type="button" className="rep-action-btn" onClick={onDuplicate}>
            <Copy size={13} /> Duplicate Rack
          </button>
          <button type="button" className="rep-action-btn" onClick={() => onExport('png')}>
            <Download size={13} /> Export PNG
          </button>
          <button type="button" className="rep-action-btn" onClick={() => onExport('pdf')}>
            <FileDown size={13} /> Export PDF
          </button>
          <button type="button" className="rep-action-btn rep-action-danger" onClick={handleDelete}>
            <Trash2 size={13} /> Delete Rack
          </button>
        </div>
      </div>
    </div>
  );
}
