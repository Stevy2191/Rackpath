import React, { useEffect, useState } from 'react';
import { Pencil, Trash2, Check, X } from 'lucide-react';
import client from '../api/client';
import { useProject } from '../project/ProjectContext';
import { nextVlanColor } from '../utils/vlanColors';
import './Vlans.css';

function emptyDraft(vlans) {
  return {
    vlan_id: '',
    name: '',
    description: '',
    subnet: '',
    color: nextVlanColor(vlans),
    _colorChanged: false,
  };
}

export default function VlansPage() {
  const { currentProjectId } = useProject();
  const [vlans, setVlans] = useState([]);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null); // row id or 'new'
  const [draft, setDraft] = useState(() => emptyDraft([]));

  const load = () => {
    if (!currentProjectId) return;
    client
      .get(`/projects/${currentProjectId}/vlans`)
      .then((res) => setVlans(res.data || []))
      .catch((err) => setError(err.message));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId]);

  const startAdd = () => {
    setDraft(emptyDraft(vlans));
    setEditingId('new');
  };

  const startEdit = (vlan) => {
    setDraft({
      vlan_id: vlan.vlan_id,
      name: vlan.name,
      description: vlan.description || '',
      subnet: vlan.subnet || '',
      color: vlan.color || '#4A90E2',
      _colorChanged: false,
    });
    setEditingId(vlan.id);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraft(emptyDraft(vlans));
    setError(null);
  };

  const saveDraft = async () => {
    const { _colorChanged, ...rest } = draft;
    const payload = {
      ...rest,
      vlan_id: rest.vlan_id === '' ? null : Number(rest.vlan_id),
    };
    if (_colorChanged) payload.user_modified_color = true;

    try {
      if (editingId === 'new') {
        const res = await client.post(`/projects/${currentProjectId}/vlans`, payload);
        setVlans((prev) => [...prev, res.data].sort((a, b) => a.vlan_id - b.vlan_id));
      } else {
        const res = await client.put(`/vlans/${editingId}`, payload);
        setVlans((prev) =>
          prev.map((v) => (v.id === editingId ? res.data : v)).sort((a, b) => a.vlan_id - b.vlan_id)
        );
      }
      cancelEdit();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  // Quick inline color change from the read-row swatch click.
  const handleColorChange = async (id, color) => {
    try {
      const res = await client.put(`/vlans/${id}`, { color, user_modified_color: true });
      setVlans((prev) => prev.map((v) => (v.id === id ? res.data : v)));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const deleteVlan = async (id) => {
    try {
      await client.delete(`/vlans/${id}`);
      setVlans((prev) => prev.filter((v) => v.id !== id));
      if (editingId === id) cancelEdit();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  return (
    <div className="vlans-page">
      <div className="vlans-header">
        <h2>VLANs</h2>
        <button type="button" className="vlans-add-btn" onClick={startAdd} disabled={editingId !== null}>
          + Add VLAN
        </button>
      </div>

      {error && <div className="page-error">{error}</div>}

      <table className="vlans-table">
        <thead>
          <tr>
            <th>VLAN ID</th>
            <th>Name</th>
            <th>Description</th>
            <th>Subnet</th>
            <th>Color</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {editingId === 'new' && (
            <tr className="vlans-row-editing">
              <td>
                <input
                  type="number"
                  min="1"
                  max="4094"
                  className="vlans-input vlans-input-narrow"
                  value={draft.vlan_id}
                  onChange={(e) => setDraft({ ...draft, vlan_id: e.target.value })}
                  placeholder="1-4094"
                  autoFocus
                />
              </td>
              <td>
                <input
                  className="vlans-input"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder="Name"
                />
              </td>
              <td>
                <input
                  className="vlans-input"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  placeholder="Description"
                />
              </td>
              <td>
                <input
                  className="vlans-input"
                  value={draft.subnet}
                  onChange={(e) => setDraft({ ...draft, subnet: e.target.value })}
                  placeholder="10.0.0.0/24"
                />
              </td>
              <td>
                <input
                  type="color"
                  className="vlans-color-input"
                  value={draft.color}
                  onChange={(e) => setDraft({ ...draft, color: e.target.value, _colorChanged: true })}
                />
              </td>
              <td className="vlans-actions">
                <button type="button" className="vlans-icon-btn" onClick={saveDraft} aria-label="Save VLAN" title="Save">
                  <Check size={15} />
                </button>
                <button type="button" className="vlans-icon-btn" onClick={cancelEdit} aria-label="Cancel" title="Cancel">
                  <X size={15} />
                </button>
              </td>
            </tr>
          )}

          {vlans.map((vlan) =>
            editingId === vlan.id ? (
              <tr key={vlan.id} className="vlans-row-editing">
                <td>
                  <input
                    type="number"
                    min="1"
                    max="4094"
                    className="vlans-input vlans-input-narrow"
                    value={draft.vlan_id}
                    onChange={(e) => setDraft({ ...draft, vlan_id: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="vlans-input"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="vlans-input"
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="vlans-input"
                    value={draft.subnet}
                    onChange={(e) => setDraft({ ...draft, subnet: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    type="color"
                    className="vlans-color-input"
                    value={draft.color}
                    onChange={(e) => setDraft({ ...draft, color: e.target.value, _colorChanged: true })}
                  />
                </td>
                <td className="vlans-actions">
                  <button type="button" className="vlans-icon-btn" onClick={saveDraft} aria-label="Save VLAN" title="Save">
                    <Check size={15} />
                  </button>
                  <button type="button" className="vlans-icon-btn" onClick={cancelEdit} aria-label="Cancel" title="Cancel">
                    <X size={15} />
                  </button>
                </td>
              </tr>
            ) : (
              <tr key={vlan.id}>
                <td>{vlan.vlan_id}</td>
                <td>{vlan.name}</td>
                <td>{vlan.description}</td>
                <td>{vlan.subnet}</td>
                <td>
                  <label className="vlans-color-swatch-label" title="Click to change color">
                    <span className="vlans-color-swatch" style={{ background: vlan.color }} />
                    <input
                      type="color"
                      className="vlans-color-hidden-input"
                      value={vlan.color}
                      onChange={(e) => handleColorChange(vlan.id, e.target.value)}
                    />
                  </label>
                </td>
                <td className="vlans-actions">
                  <button
                    type="button"
                    className="vlans-icon-btn"
                    onClick={() => startEdit(vlan)}
                    aria-label="Edit VLAN"
                    title="Edit"
                    disabled={editingId !== null}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="vlans-icon-btn vlans-icon-btn-danger"
                    onClick={() => deleteVlan(vlan.id)}
                    aria-label="Delete VLAN"
                    title="Delete"
                    disabled={editingId !== null}
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            )
          )}

          {vlans.length === 0 && editingId !== 'new' && (
            <tr>
              <td colSpan={6} className="vlans-empty">
                No VLANs defined yet. Click "+ Add VLAN" to create one.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
