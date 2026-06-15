import React, { useState } from 'react';

const RACK_TYPES = [
  { value: '4-post', label: '4-Post Rack' },
  { value: '2-post', label: '2-Post Rack' },
  { value: 'wall-mount', label: 'Wall Mount' },
  { value: 'open-frame', label: 'Open Frame' },
  { value: 'blade-enclosure', label: 'Blade Enclosure' },
];

const empty = { name: '', location: '', u_height: 42, rack_type: '4-post', notes: '' };

export default function AddRackModal({ onClose, onCreate }) {
  const [rack, setRack] = useState(empty);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!rack.name.trim()) {
      setError('Name is required');
      return;
    }
    try {
      await onCreate(rack);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  return (
    <div className="rack-modal-overlay" onMouseDown={onClose}>
      <div className="rack-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Add Rack</h3>
        <form onSubmit={handleSubmit}>
          <label>
            Name
            <input
              value={rack.name}
              onChange={(e) => setRack({ ...rack, name: e.target.value })}
              placeholder="Rack name"
              autoFocus
              required
            />
          </label>
          <label>
            Location
            <input
              value={rack.location}
              onChange={(e) => setRack({ ...rack, location: e.target.value })}
              placeholder="e.g. Server Room A"
            />
          </label>
          <label>
            U Height
            <input
              type="number"
              min="4"
              max="52"
              value={rack.u_height}
              onChange={(e) => setRack({ ...rack, u_height: Number(e.target.value) })}
            />
          </label>
          <label>
            Rack Type
            <select value={rack.rack_type} onChange={(e) => setRack({ ...rack, rack_type: e.target.value })}>
              {RACK_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Notes
            <textarea
              value={rack.notes}
              onChange={(e) => setRack({ ...rack, notes: e.target.value })}
              rows={2}
            />
          </label>

          {error && <div className="rack-modal-error">{error}</div>}

          <div className="rack-modal-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="rack-modal-save">
              Add Rack
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
