import React, { useState } from 'react';
import '../topology/Modal.css';
import './BulkEditModal.css';

// Picks readable foreground text for a colored tag pill.
function pillTextColor(hex) {
  if (!hex || hex.length !== 7) return '#fff';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1a1a1a' : '#ffffff';
}

export default function BulkEditModal({ count, tags = [], macros = [], showTags = true, showCredentialMacro = true, onSave, onClose }) {
  const [location, setLocation] = useState('');
  const [tagIds, setTagIds] = useState([]);
  const [tagMode, setTagMode] = useState('add'); // 'add' = append to existing tags, 'replace' = set tags
  const [credentialMacro, setCredentialMacro] = useState('');
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const toggleTag = (tagId) => {
    setTagIds((prev) => (prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const fields = {};
    if (location.trim()) fields.location = location.trim();
    // "Replace" mode is sent even with zero tags selected (clears all tags on
    // the selected rows); "Add" mode is a no-op if nothing is selected.
    if (tagIds.length > 0 || tagMode === 'replace') {
      fields.tag_ids = tagIds;
      fields.tag_mode = tagMode;
    }
    if (credentialMacro !== '') fields.credential_macro_id = credentialMacro === 'none' ? null : Number(credentialMacro);
    if (status !== '') fields.status = status;

    console.log('[BulkEditModal] submitting bulk edit fields:', fields);

    if (Object.keys(fields).length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave(fields);
    } catch (err) {
      console.error('[BulkEditModal] bulk edit save failed:', err);
      setError(err.response?.data?.error || err.message);
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-small" onClick={(e) => e.stopPropagation()}>
        <h2>Edit {count} Selected</h2>
        <p className="bulk-edit-hint">Only fields you change here will be applied to all selected rows.</p>

        {error && <div className="integration-form-error">{error}</div>}

        <form onSubmit={handleSubmit} className="modal-form">
          <label>
            Location
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Leave blank to leave unchanged"
            />
          </label>

          {showTags && (
            <label>
              Tags
              <div className="bulk-edit-tag-mode">
                <label className="bulk-edit-radio">
                  <input
                    type="radio"
                    name="tagMode"
                    value="add"
                    checked={tagMode === 'add'}
                    onChange={() => setTagMode('add')}
                  />
                  Add to existing tags
                </label>
                <label className="bulk-edit-radio">
                  <input
                    type="radio"
                    name="tagMode"
                    value="replace"
                    checked={tagMode === 'replace'}
                    onChange={() => setTagMode('replace')}
                  />
                  Replace existing tags
                </label>
              </div>
              {tags.length === 0 ? (
                <span className="bulk-edit-empty">No tags defined for this project</span>
              ) : (
                <div className="bulk-edit-tag-list">
                  {tags.map((tag) => (
                    <button
                      key={tag.id}
                      type="button"
                      className={`device-tag-pill${tagIds.includes(tag.id) ? ' active' : ''}`}
                      style={{ background: tag.color, color: pillTextColor(tag.color) }}
                      onClick={() => toggleTag(tag.id)}
                    >
                      {tag.name}
                    </button>
                  ))}
                </div>
              )}
            </label>
          )}

          {showCredentialMacro && (
            <label>
              Credential Macro
              <select value={credentialMacro} onChange={(e) => setCredentialMacro(e.target.value)}>
                <option value="">Leave unchanged</option>
                <option value="none">— None —</option>
                {macros.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label>
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Leave unchanged</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>

          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={saving}>
              {saving ? 'Applying...' : 'Apply'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
