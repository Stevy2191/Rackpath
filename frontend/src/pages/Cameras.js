import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, Clipboard, Loader2, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import client from '../api/client';
import { useProject } from '../project/ProjectContext';
import CameraFormModal from '../components/cameras/CameraFormModal';
import BulkActionToolbar from '../components/devices/BulkActionToolbar';
import BulkEditModal from '../components/devices/BulkEditModal';
import './Cameras.css';

function formatLastSeen(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleString();
}

const RTSPS_FIELDS = [
  { key: 'rtsps_url_high', label: 'High' },
  { key: 'rtsps_url_medium', label: 'Medium' },
  { key: 'rtsps_url_low', label: 'Low' },
];

export default function CamerasPage() {
  const { currentProjectId } = useProject();
  const [cameras, setCameras] = useState([]);
  const [error, setError] = useState(null);
  const [modalState, setModalState] = useState(null); // null | 'new' | camera object
  const [search, setSearch] = useState('');
  const [revealed, setRevealed] = useState(new Set());
  const [protectIntegration, setProtectIntegration] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [showBulkEdit, setShowBulkEdit] = useState(false);

  const load = () => {
    if (!currentProjectId) return;
    client
      .get(`/projects/${currentProjectId}/cameras`)
      .then((res) => setCameras(res.data || []))
      .catch((err) => setError(err.response?.data?.error || err.message));
  };

  const loadIntegrations = () => {
    if (!currentProjectId) return;
    client
      .get(`/projects/${currentProjectId}/integrations`)
      .then((res) => setProtectIntegration((res.data || []).find((i) => i.platform === 'unifi-protect') || null))
      .catch(() => setProtectIntegration(null));
  };

  useEffect(() => {
    load();
    loadIntegrations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId]);

  const showToast = (toastInfo) => {
    setToast(toastInfo);
    setTimeout(() => setToast(null), 6000);
  };

  const toggleReveal = (id, field) => {
    setRevealed((prev) => {
      const key = `${id}:${field}`;
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const copyValue = async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      showToast({ type: 'success', text: 'Copied to clipboard' });
    } catch {
      showToast({ type: 'error', text: 'Could not copy to clipboard' });
    }
  };

  const handleSave = async (draft) => {
    if (modalState === 'new') {
      const res = await client.post(`/projects/${currentProjectId}/cameras`, draft);
      setCameras((prev) => [...prev, res.data].sort((a, b) => a.name.localeCompare(b.name)));
    } else {
      const res = await client.put(`/cameras/${modalState.id}`, draft);
      setCameras((prev) => prev.map((c) => (c.id === modalState.id ? res.data : c)));
    }
    setModalState(null);
  };

  const handleDelete = async (camera) => {
    if (!window.confirm(`Delete camera "${camera.name}"?`)) return;
    try {
      await client.delete(`/cameras/${camera.id}`);
      setCameras((prev) => prev.filter((c) => c.id !== camera.id));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (rows) => {
    const ids = rows.map((r) => r.id);
    const allSelected = ids.length > 0 && ids.every((id) => selectedIds.has(id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        ids.forEach((id) => next.delete(id));
      } else {
        ids.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`Delete ${selectedIds.size} selected camera${selectedIds.size === 1 ? '' : 's'}?`)) return;
    try {
      const items = Array.from(selectedIds).map((id) => ({ id, source: 'camera' }));
      await client.post('/devices/bulk-delete', { items });
      setSelectedIds(new Set());
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleBulkEditSave = async (fields) => {
    const items = Array.from(selectedIds).map((id) => ({ id, source: 'camera' }));
    console.log('[Cameras] bulk-update request:', { items, ...fields });
    const res = await client.post('/devices/bulk-update', { items, ...fields });
    console.log('[Cameras] bulk-update response:', res.data);
    setSelectedIds(new Set());
    setShowBulkEdit(false);
    load();
  };

  const handleSync = async () => {
    if (!protectIntegration) return;
    setSyncing(true);
    try {
      const res = await client.post(`/integrations/${protectIntegration.id}/sync`);
      const { cameras_imported, status, message } = res.data;
      if (status === 'failed') {
        showToast({ type: 'error', text: message || 'Sync failed' });
      } else {
        showToast({
          type: 'success',
          text: `Sync complete — ${cameras_imported} camera${cameras_imported === 1 ? '' : 's'} imported`,
        });
      }
      load();
    } catch (err) {
      showToast({ type: 'error', text: err.response?.data?.error || err.message });
    } finally {
      setSyncing(false);
    }
  };

  const renderRtspsCell = (camera) => (
    <td className="cameras-rtsps-cell">
      {RTSPS_FIELDS.map(({ key, label }) => {
        const value = camera[key];
        const isRevealed = revealed.has(`${camera.id}:${key}`);
        return (
          <div className="cameras-rtsps-row" key={key}>
            <span className="cameras-rtsps-label">{label}</span>
            <span
              className={`cameras-rtsps-value${isRevealed ? ' cameras-rtsps-value-revealed' : ''}`}
              title={value || undefined}
            >
              {value ? (isRevealed ? value : '••••••••') : '—'}
            </span>
            {value && (
              <>
                <button
                  type="button"
                  className="cameras-icon-btn"
                  onClick={() => toggleReveal(camera.id, key)}
                  aria-label={isRevealed ? 'Hide' : 'Show'}
                  title={isRevealed ? 'Hide' : 'Show'}
                >
                  {isRevealed ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                <button
                  type="button"
                  className="cameras-icon-btn"
                  onClick={() => copyValue(value)}
                  aria-label="Copy"
                  title="Copy to clipboard"
                >
                  <Clipboard size={14} />
                </button>
              </>
            )}
          </div>
        );
      })}
    </td>
  );

  const renderPasswordCell = (camera) => {
    const value = camera.stream_password;
    const isRevealed = revealed.has(`${camera.id}:stream_password`);
    return (
      <td className="cameras-rtsps-cell cameras-password-cell">
        <div className="cameras-rtsps-row">
          <span
            className={`cameras-rtsps-value${isRevealed ? ' cameras-rtsps-value-revealed' : ''}`}
            title={value || undefined}
          >
            {value ? (isRevealed ? value : '••••••••') : '—'}
          </span>
          {value && (
            <>
              <button
                type="button"
                className="cameras-icon-btn"
                onClick={() => toggleReveal(camera.id, 'stream_password')}
                aria-label={isRevealed ? 'Hide' : 'Show'}
                title={isRevealed ? 'Hide' : 'Show'}
              >
                {isRevealed ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
              <button
                type="button"
                className="cameras-icon-btn"
                onClick={() => copyValue(value)}
                aria-label="Copy"
                title="Copy to clipboard"
              >
                <Clipboard size={14} />
              </button>
            </>
          )}
        </div>
      </td>
    );
  };

  const filtered = cameras.filter((c) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return [c.name, c.model, c.ip_address].some((v) => (v || '').toLowerCase().includes(q));
  });

  return (
    <div className="cameras-page">
      <div className="cameras-header">
        <h2>Cameras</h2>
        <div className="cameras-header-actions">
          {protectIntegration && (
            <button type="button" className="cameras-sync-btn" onClick={handleSync} disabled={syncing}>
              {syncing ? <Loader2 size={14} className="cameras-spin" /> : <RefreshCw size={14} />}
              Sync from UniFi Protect
            </button>
          )}
          <button type="button" className="cameras-add-btn" onClick={() => setModalState('new')}>
            + Add Camera
          </button>
        </div>
      </div>

      <div className="cameras-search">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, model, or IP..."
        />
      </div>

      {error && <div className="page-error">{error}</div>}

      <div className="cameras-count">{filtered.length} camera{filtered.length === 1 ? '' : 's'}</div>

      <BulkActionToolbar
        count={selectedIds.size}
        onEdit={() => setShowBulkEdit(true)}
        onDelete={handleBulkDelete}
        onClear={() => setSelectedIds(new Set())}
      />

      <div className="cameras-table-wrap">
        <table className="cameras-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={filtered.length > 0 && filtered.every((c) => selectedIds.has(c.id))}
                  onChange={() => toggleSelectAll(filtered)}
                />
              </th>
              <th>Status</th>
              <th>Name</th>
              <th>Model</th>
              <th>IP Address</th>
              <th>RTSPS Streams</th>
              <th title="This is the recovery code shown in Protect under camera Settings → Manage → Manual Recovery">
                Recovery Code / Stream Password
              </th>
              <th>Last Seen</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((camera) => (
              <tr key={camera.id}>
                <td>
                  <input type="checkbox" checked={selectedIds.has(camera.id)} onChange={() => toggleSelect(camera.id)} />
                </td>
                <td>
                  <span className={`cameras-status-dot cameras-status-${camera.status || 'unknown'}`} title={camera.status} />
                </td>
                <td>{camera.name}</td>
                <td>{camera.model || '—'}</td>
                <td>{camera.ip_address || '—'}</td>
                {renderRtspsCell(camera)}
                {renderPasswordCell(camera)}
                <td>{formatLastSeen(camera.last_seen)}</td>
                <td className="cameras-actions">
                  <button
                    type="button"
                    className="cameras-icon-btn"
                    onClick={() => setModalState(camera)}
                    aria-label="Edit camera"
                    title="Edit"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="cameras-icon-btn cameras-icon-btn-danger"
                    onClick={() => handleDelete(camera)}
                    aria-label="Delete camera"
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </td>
              </tr>
            ))}

            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="cameras-empty">
                  {cameras.length === 0 ? 'No cameras yet. Click "+ Add Camera" to create one.' : 'No cameras match your search.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modalState && (
        <CameraFormModal initial={modalState === 'new' ? null : modalState} onSave={handleSave} onClose={() => setModalState(null)} />
      )}

      {showBulkEdit && (
        <BulkEditModal
          count={selectedIds.size}
          showTags={false}
          showCredentialMacro={false}
          onSave={handleBulkEditSave}
          onClose={() => setShowBulkEdit(false)}
        />
      )}

      {toast && <div className={`cameras-toast cameras-toast-${toast.type}`}>{toast.text}</div>}
    </div>
  );
}
