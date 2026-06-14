import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
import client from '../api/client';
import { useProject } from '../project/ProjectContext';
import MacroFormModal, { MACRO_TYPE_LABELS } from '../components/macros/MacroFormModal';
import './Macros.css';

export default function MacrosPage() {
  const { currentProjectId } = useProject();
  const [macros, setMacros] = useState([]);
  const [error, setError] = useState(null);
  const [editingMacro, setEditingMacro] = useState(null); // null | 'new' | macro object
  const [revealedIds, setRevealedIds] = useState(new Set());

  const load = () => {
    if (!currentProjectId) return;
    client
      .get(`/projects/${currentProjectId}/macros`)
      .then((res) => setMacros(res.data || []))
      .catch((err) => setError(err.message));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId]);

  const toggleReveal = (id) => {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = async (draft) => {
    if (editingMacro === 'new') {
      const res = await client.post(`/projects/${currentProjectId}/macros`, draft);
      setMacros((prev) => [...prev, res.data].sort((a, b) => a.name.localeCompare(b.name)));
    } else {
      const res = await client.put(`/macros/${editingMacro.id}`, draft);
      setMacros((prev) => prev.map((m) => (m.id === editingMacro.id ? res.data : m)));
    }
    setEditingMacro(null);
  };

  const handleDelete = async (macro) => {
    if (!window.confirm(`Delete macro "${macro.name}"?`)) return;
    try {
      await client.delete(`/macros/${macro.id}`);
      setMacros((prev) => prev.filter((m) => m.id !== macro.id));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const secretFor = (macro) => {
    if (macro.type === 'snmp_v1' || macro.type === 'snmp_v2c') return macro.community_string || '';
    return macro.username || '';
  };

  return (
    <div className="macros-page">
      <div className="macros-header">
        <h2>Credential Macros</h2>
        <button type="button" className="macros-add-btn" onClick={() => setEditingMacro('new')}>
          + Add Macro
        </button>
      </div>

      {error && <div className="page-error">{error}</div>}

      <table className="macros-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Community/Username</th>
            <th>Port</th>
            <th>Notes</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {macros.map((macro) => {
            const secret = secretFor(macro);
            const revealed = revealedIds.has(macro.id);
            return (
              <tr key={macro.id}>
                <td>{macro.name}</td>
                <td>{MACRO_TYPE_LABELS[macro.type] || macro.type}</td>
                <td className="macros-secret-cell">
                  <span className="macros-secret-value">{revealed ? secret || '—' : secret ? '••••••••' : '—'}</span>
                  {secret && (
                    <button
                      type="button"
                      className="macros-icon-btn"
                      onClick={() => toggleReveal(macro.id)}
                      aria-label={revealed ? 'Hide' : 'Show'}
                      title={revealed ? 'Hide' : 'Show'}
                    >
                      {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  )}
                </td>
                <td>{macro.port ?? '—'}</td>
                <td>{macro.notes || ''}</td>
                <td className="macros-actions">
                  <button
                    type="button"
                    className="macros-icon-btn"
                    onClick={() => setEditingMacro(macro)}
                    aria-label="Edit macro"
                    title="Edit"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="macros-icon-btn macros-icon-btn-danger"
                    onClick={() => handleDelete(macro)}
                    aria-label="Delete macro"
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            );
          })}

          {macros.length === 0 && (
            <tr>
              <td colSpan={6} className="macros-empty">
                No credential macros yet. Click "+ Add Macro" to create one.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editingMacro && (
        <MacroFormModal
          initial={editingMacro === 'new' ? null : editingMacro}
          onSave={handleSave}
          onClose={() => setEditingMacro(null)}
        />
      )}
    </div>
  );
}
