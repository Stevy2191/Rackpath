import React, { useState } from 'react';

const RACK_TYPES = [
  { value: '4-post', label: '4-Post Rack' },
  { value: '2-post', label: '2-Post Rack' },
  { value: 'wall-mount', label: 'Wall Mount' },
  { value: 'open-frame', label: 'Open Frame' },
  { value: 'blade-enclosure', label: 'Blade Enclosure' },
];

const WIDTH_OPTIONS = [
  { value: '10"', label: '10"', sub: 'Compact' },
  { value: '19"', label: '19"', sub: 'Standard' },
  { value: '21"', label: '21"', sub: 'Wide' },
  { value: '23"', label: '23"', sub: 'Telco' },
];

const HEIGHT_PRESETS = [8, 12, 16, 24, 32, 42, 47];

const EMPTY = {
  name: '',
  location: '',
  u_height: 42,
  rack_type: '4-post',
  rack_width: '19"',
  notes: '',
};

export default function AddRackModal({ onClose, onCreate }) {
  const [step, setStep] = useState(1);
  const [rack, setRack] = useState(EMPTY);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (key, val) => setRack((r) => ({ ...r, [key]: val }));

  const handleSubmit = async () => {
    if (!rack.name.trim()) { setError('Name is required'); return; }
    setSubmitting(true);
    try {
      await onCreate(rack);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setSubmitting(false);
    }
  };

  return (
    <div className="rack-modal-overlay" onMouseDown={onClose}>
      <div className="rack-modal add-rack-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="add-rack-modal-header">
          <h3>Add Rack</h3>
          <div className="add-rack-steps">
            <span className={step === 1 ? 'active' : ''}>1. Name</span>
            <span className="add-rack-step-sep">›</span>
            <span className={step === 2 ? 'active' : ''}>2. Size</span>
          </div>
        </div>

        {step === 1 ? (
          <div className="add-rack-step">
            <label>
              Rack Name
              <input
                value={rack.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="e.g. Core Switch Rack"
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter' && rack.name.trim()) setStep(2); }}
              />
            </label>

            <label>
              Location
              <input
                value={rack.location}
                onChange={(e) => set('location', e.target.value)}
                placeholder="e.g. Server Room A"
              />
            </label>

            <label>
              Rack Type
              <select value={rack.rack_type} onChange={(e) => set('rack_type', e.target.value)}>
                {RACK_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </label>

            {error && <div className="rack-modal-error">{error}</div>}

            <div className="rack-modal-actions">
              <button type="button" onClick={onClose}>Cancel</button>
              <button
                type="button"
                className="rack-modal-save"
                disabled={!rack.name.trim()}
                onClick={() => { if (rack.name.trim()) { setError(null); setStep(2); } else setError('Name is required'); }}
              >
                Next →
              </button>
            </div>
          </div>
        ) : (
          <div className="add-rack-step">
            <div className="add-rack-field-label">Width</div>
            <div className="add-rack-width-cards">
              {WIDTH_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`add-rack-width-card${rack.rack_width === opt.value ? ' selected' : ''}`}
                  onClick={() => set('rack_width', opt.value)}
                >
                  <span className="add-rack-width-label">{opt.label}</span>
                  <span className="add-rack-width-sub">{opt.sub}</span>
                </button>
              ))}
            </div>

            <div className="add-rack-field-label">Height</div>
            <div className="add-rack-height-presets">
              {HEIGHT_PRESETS.map((h) => (
                <button
                  key={h}
                  type="button"
                  className={`add-rack-preset-btn${rack.u_height === h ? ' selected' : ''}`}
                  onClick={() => set('u_height', h)}
                >
                  {h}U
                </button>
              ))}
            </div>
            <div className="add-rack-slider-row">
              <input
                type="range"
                min={1}
                max={100}
                value={rack.u_height}
                onChange={(e) => set('u_height', Number(e.target.value))}
              />
              <span className="add-rack-slider-val">{rack.u_height}U</span>
            </div>

            <label>
              Notes
              <textarea
                value={rack.notes}
                onChange={(e) => set('notes', e.target.value)}
                rows={2}
                placeholder="Optional notes..."
              />
            </label>

            {error && <div className="rack-modal-error">{error}</div>}

            <div className="rack-modal-actions">
              <button type="button" onClick={() => setStep(1)}>← Back</button>
              <button
                type="button"
                className="rack-modal-save"
                disabled={submitting}
                onClick={handleSubmit}
              >
                {submitting ? 'Adding...' : 'Add Rack'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
