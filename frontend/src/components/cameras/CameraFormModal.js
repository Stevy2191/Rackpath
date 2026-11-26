import React, { useState } from 'react';
import '../topology/Modal.css';

export const emptyCamera = {
  name: '',
  model: '',
  mac: '',
  ip_address: '',
  resolution: '',
  location_notes: '',
};

export default function CameraFormModal({ initial, onSave, onClose }) {
  const [draft, setDraft] = useState(initial || emptyCamera);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const field = (name) => (e) => setDraft((prev) => ({ ...prev, [name]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!draft.name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-small" onClick={(e) => e.stopPropagation()}>
        <h2>{initial ? 'Edit Camera' : 'Add Camera'}</h2>

        {error && <div className="integration-form-error">{error}</div>}

        <form onSubmit={handleSubmit} className="modal-form">
          <label>
            Name
            <input value={draft.name} onChange={field('name')} placeholder="e.g. Front Door" autoFocus required />
          </label>
          <label>
            Model
            <input value={draft.model || ''} onChange={field('model')} placeholder="e.g. G4 Bullet" />
          </label>
          <label>
            MAC Address
            <input value={draft.mac || ''} onChange={field('mac')} placeholder="aa:bb:cc:dd:ee:ff" />
          </label>
          <label>
            IP Address
            <input value={draft.ip_address || ''} onChange={field('ip_address')} placeholder="192.168.1.50" />
          </label>
          <label>
            Resolution
            <input value={draft.resolution || ''} onChange={field('resolution')} placeholder="1920x1080" />
          </label>
          <label>
            Location Notes
            <input value={draft.location_notes || ''} onChange={field('location_notes')} placeholder="e.g. Rack 3, top shelf" />
          </label>

          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
