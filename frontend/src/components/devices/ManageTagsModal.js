import React, { useState } from 'react';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import client from '../../api/client';
import { COLOR_SWATCHES } from '../topology/deviceTypes';
import '../topology/Modal.css';
import './ManageTagsModal.css';

function ColorSwatchRow({ value, onChange }) {
  return (
    <div className="tag-color-swatches">
      {COLOR_SWATCHES.map((c) => (
        <button
          key={c.name}
          type="button"
          aria-label={c.name}
          title={c.name}
          className={`tag-color-swatch${value === c.hex ? ' selected' : ''}`}
          style={{ background: c.hex }}
          onClick={() => onChange(c.hex)}
        />
      ))}
    </div>
  );
}

export default function ManageTagsModal({ projectId, tags, onClose, onChange }) {
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(COLOR_SWATCHES[0].hex);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');
  const [error, setError] = useState(null);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      await client.post(`/projects/${projectId}/device-tags`, { name: newName.trim(), color: newColor });
      setNewName('');
      setNewColor(COLOR_SWATCHES[0].hex);
      setError(null);
      onChange();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const startEdit = (tag) => {
    setEditingId(tag.id);
    setEditName(tag.name);
    setEditColor(tag.color || COLOR_SWATCHES[0].hex);
  };

  const cancelEdit = () => setEditingId(null);

  const handleSaveEdit = async () => {
    if (!editName.trim()) return;
    try {
      await client.put(`/device-tags/${editingId}`, { name: editName.trim(), color: editColor });
      setEditingId(null);
      setError(null);
      onChange();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleDelete = async (tag) => {
    if (!window.confirm(`Delete tag "${tag.name}"? It will be removed from all devices.`)) return;
    try {
      await client.delete(`/device-tags/${tag.id}`);
      onChange();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-small" onClick={(e) => e.stopPropagation()}>
        <h2>Manage Tags</h2>

        {error && <div className="integration-form-error">{error}</div>}

        {tags.length === 0 ? (
          <div className="manage-tags-empty">No tags yet.</div>
        ) : (
          <ul className="manage-tags-list">
            {tags.map((tag) => (
              <li key={tag.id} className="manage-tags-item">
                {editingId === tag.id ? (
                  <div className="manage-tags-edit">
                    <input
                      className="manage-tags-edit-name"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      autoFocus
                    />
                    <ColorSwatchRow value={editColor} onChange={setEditColor} />
                    <div className="manage-tags-edit-actions">
                      <button type="button" onClick={handleSaveEdit}>
                        Save
                      </button>
                      <button type="button" onClick={cancelEdit}>
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span className="manage-tags-swatch" style={{ background: tag.color }} />
                    <span className="manage-tags-name">{tag.name}</span>
                    <button type="button" className="manage-tags-icon-btn" onClick={() => startEdit(tag)} aria-label="Edit tag" title="Edit">
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="manage-tags-icon-btn manage-tags-icon-btn-danger"
                      onClick={() => handleDelete(tag)}
                      aria-label="Delete tag"
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={handleCreate} className="manage-tags-new">
          <input
            className="manage-tags-new-name"
            placeholder="New tag name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <ColorSwatchRow value={newColor} onChange={setNewColor} />
          <button type="submit" className="manage-tags-new-btn" disabled={!newName.trim()}>
            <Plus size={14} /> New Tag
          </button>
        </form>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
