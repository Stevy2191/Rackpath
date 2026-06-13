import React, { useState } from 'react';
import './Modal.css';
import './AddNodeModal.css';

export default function AddNodeModal({ deviceInfo, devices, onConfirmStandalone, onConfirmLink, onCancel }) {
  const [mode, setMode] = useState('standalone');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState('');

  const term = search.trim().toLowerCase();
  const filtered = (devices || []).filter((d) => {
    if (!term) return true;
    return (d.hostname || '').toLowerCase().includes(term) || (d.ip || '').toLowerCase().includes(term);
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (mode === 'link') {
      if (!selectedId) return;
      onConfirmLink(Number(selectedId));
    } else {
      onConfirmStandalone();
    }
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-small" onClick={(e) => e.stopPropagation()}>
        <h2>Add {deviceInfo?.label || 'Node'}</h2>
        <form className="modal-form" onSubmit={handleSubmit}>
          <label className="add-node-option">
            <input
              type="radio"
              name="add-node-mode"
              value="standalone"
              checked={mode === 'standalone'}
              onChange={() => setMode('standalone')}
            />
            Standalone node (diagram only)
          </label>
          <label className="add-node-option">
            <input
              type="radio"
              name="add-node-mode"
              value="link"
              checked={mode === 'link'}
              onChange={() => setMode('link')}
            />
            Link to existing device
          </label>

          {mode === 'link' && (
            <div className="add-node-link-picker">
              <input
                type="text"
                placeholder="Search by hostname or IP..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select
                className="add-node-link-select"
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                size={6}
              >
                {filtered.length === 0 && <option disabled>No matching devices</option>}
                {filtered.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.hostname || d.ip || `Device ${d.id}`}
                    {d.hostname && d.ip ? ` (${d.ip})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="modal-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" disabled={mode === 'link' && !selectedId}>
              Add
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
