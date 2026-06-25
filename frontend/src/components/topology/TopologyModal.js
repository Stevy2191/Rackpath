import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import './TopologyModal.css';

export default function TopologyModal({ topology, locations, onSave, onClose }) {
  const isEdit = Boolean(topology?.id);

  const [name, setName] = useState(topology?.name || '');
  const [description, setDescription] = useState(topology?.description || '');
  const [locationId, setLocationId] = useState(topology?.location_id || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setName(topology?.name || '');
    setDescription(topology?.description || '');
    setLocationId(topology?.location_id || '');
    setError(null);
  }, [topology]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), description: description.trim() || null, location_id: locationId || null });
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="topo-modal-overlay" onClick={onClose}>
      <div className="topo-modal" onClick={(e) => e.stopPropagation()}>
        <div className="topo-modal-header">
          <h3>{isEdit ? 'Edit Topology' : 'New Topology'}</h3>
          <button type="button" onClick={onClose} className="topo-modal-close"><X size={16} /></button>
        </div>

        <form onSubmit={handleSubmit} className="topo-modal-body">
          {error && <div className="topo-modal-error">{error}</div>}

          <label className="topo-modal-field">
            <span>Name <span aria-hidden="true">*</span></span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Main Topology"
              autoFocus
              required
            />
          </label>

          <label className="topo-modal-field">
            <span>Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description…"
              rows={3}
            />
          </label>

          <label className="topo-modal-field">
            <span>Associated Location</span>
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">— None —</option>
              {(locations || []).map((loc) => (
                <option key={loc.id} value={loc.id}>{loc.name}</option>
              ))}
            </select>
          </label>

          <div className="topo-modal-footer">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary" disabled={saving}>
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
