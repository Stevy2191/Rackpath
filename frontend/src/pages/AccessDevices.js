import React, { useEffect, useState } from 'react';
import { Loader2, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import client from '../api/client';
import { useProject } from '../project/ProjectContext';
import AccessDeviceFormModal from '../components/access-devices/AccessDeviceFormModal';
import './AccessDevices.css';

const DEVICE_TYPE_LABELS = {
  'ua-hub': 'UA Hub',
  'ua-pro': 'UA Pro',
  'ua-g2': 'UA G2',
  'ua-g2-mini': 'UA G2 Mini',
  'ua-intercom': 'UA Intercom',
  'ua-elevator': 'UA Elevator',
  'ua-reader': 'UA Reader',
  'ua-reader-lite': 'UA Reader Lite',
  'ua-door-controller': 'UA Door Controller',
  other: 'Other',
};

function deviceTypeLabel(type) {
  return DEVICE_TYPE_LABELS[type] || type || 'Unknown';
}

function statusClass(device) {
  if (!device.last_seen) return 'unknown';
  return device.online ? 'online' : 'offline';
}

function lockStateClass(state) {
  if (state === 'unlocked') return 'green';
  if (state === 'locked') return 'red';
  return 'grey';
}

function openStateClass(state) {
  if (state === 'closed') return 'green';
  if (state === 'open') return 'red';
  return 'grey';
}

function formatLastSeen(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleString();
}

export default function AccessDevicesPage() {
  const { currentProjectId } = useProject();
  const [devices, setDevices] = useState([]);
  const [error, setError] = useState(null);
  const [modalState, setModalState] = useState(null); // null | 'new' | device object
  const [search, setSearch] = useState('');
  const [accessIntegration, setAccessIntegration] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState(null);

  const load = () => {
    if (!currentProjectId) return;
    client
      .get(`/projects/${currentProjectId}/access-devices`)
      .then((res) => setDevices(res.data || []))
      .catch((err) => setError(err.response?.data?.error || err.message));
  };

  const loadIntegrations = () => {
    if (!currentProjectId) return;
    client
      .get(`/projects/${currentProjectId}/integrations`)
      .then((res) => setAccessIntegration((res.data || []).find((i) => i.platform === 'unifi-access') || null))
      .catch(() => setAccessIntegration(null));
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

  const handleSave = async (draft) => {
    if (modalState === 'new') {
      const res = await client.post(`/projects/${currentProjectId}/access-devices`, draft);
      setDevices((prev) => [...prev, res.data].sort((a, b) => a.name.localeCompare(b.name)));
    } else {
      const res = await client.put(`/access-devices/${modalState.id}`, draft);
      setDevices((prev) => prev.map((d) => (d.id === modalState.id ? res.data : d)));
    }
    setModalState(null);
  };

  const handleDelete = async (device) => {
    if (!window.confirm(`Delete access device "${device.name}"?`)) return;
    try {
      await client.delete(`/access-devices/${device.id}`);
      setDevices((prev) => prev.filter((d) => d.id !== device.id));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleSync = async () => {
    if (!accessIntegration) return;
    setSyncing(true);
    try {
      const res = await client.post(`/integrations/${accessIntegration.id}/sync`);
      const { access_devices_imported, status, message } = res.data;
      if (status === 'failed') {
        showToast({ type: 'error', text: message || 'Sync failed' });
      } else {
        showToast({
          type: 'success',
          text: `Sync complete — ${access_devices_imported} device${access_devices_imported === 1 ? '' : 's'} imported`,
        });
      }
      load();
    } catch (err) {
      showToast({ type: 'error', text: err.response?.data?.error || err.message });
    } finally {
      setSyncing(false);
    }
  };

  const filtered = devices.filter((d) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return [d.name, d.door_name, d.location, d.model, d.ip_address].some((v) => (v || '').toLowerCase().includes(q));
  });

  return (
    <div className="access-devices-page">
      <div className="access-devices-header">
        <h2>Access Devices</h2>
        <div className="access-devices-header-actions">
          {accessIntegration && (
            <button type="button" className="access-devices-sync-btn" onClick={handleSync} disabled={syncing}>
              {syncing ? <Loader2 size={14} className="access-devices-spin" /> : <RefreshCw size={14} />}
              Sync from UniFi Access
            </button>
          )}
          <button type="button" className="access-devices-add-btn" onClick={() => setModalState('new')}>
            + Add Access Device
          </button>
        </div>
      </div>

      <div className="access-devices-search">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, door, location, model, or IP..."
        />
      </div>

      {error && <div className="page-error">{error}</div>}

      <div className="access-devices-count">
        {filtered.length} device{filtered.length === 1 ? '' : 's'}
      </div>

      <div className="access-devices-table-wrap">
        <table className="access-devices-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Name</th>
              <th>Device Type</th>
              <th>Model</th>
              <th>IP Address</th>
              <th>Door Name</th>
              <th>Location</th>
              <th>Floor</th>
              <th>Lock State</th>
              <th>Door State</th>
              <th>Connected Readers</th>
              <th>Access Groups</th>
              <th>Unlock Schedules</th>
              <th>Firmware Version</th>
              <th>Last Seen</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((device) => {
              const readers = device.connected_readers || [];
              const groups = device.access_groups || [];
              const schedules = device.unlock_schedules || [];
              return (
                <tr key={device.id}>
                  <td>
                    <span
                      className={`access-devices-status-dot access-devices-status-${statusClass(device)}`}
                      title={statusClass(device)}
                    />
                  </td>
                  <td>{device.name}</td>
                  <td>
                    <span className="access-devices-badge access-devices-badge-grey">{deviceTypeLabel(device.device_type)}</span>
                  </td>
                  <td>{device.model || '—'}</td>
                  <td>{device.ip_address || '—'}</td>
                  <td>{device.door_name || '—'}</td>
                  <td>{device.location || '—'}</td>
                  <td>{device.floor || '—'}</td>
                  <td>
                    <span className={`access-devices-badge access-devices-badge-${lockStateClass(device.door_lock_state)}`}>
                      {device.door_lock_state || 'unknown'}
                    </span>
                  </td>
                  <td>
                    <span className={`access-devices-badge access-devices-badge-${openStateClass(device.door_open_state)}`}>
                      {device.door_open_state || 'unknown'}
                    </span>
                  </td>
                  <td>{readers.length > 0 ? readers.join(', ') : '—'}</td>
                  <td>
                    {groups.length > 0 ? (
                      <div className="access-devices-pill-list">
                        {groups.map((g) => (
                          <span key={g} className="access-devices-pill">
                            {g}
                          </span>
                        ))}
                      </div>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{schedules.length > 0 ? schedules.join(', ') : '—'}</td>
                  <td>{device.firmware_version || '—'}</td>
                  <td>{formatLastSeen(device.last_seen)}</td>
                  <td className="access-devices-actions">
                    <button
                      type="button"
                      className="access-devices-icon-btn"
                      onClick={() => setModalState(device)}
                      aria-label="Edit access device"
                      title="Edit"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="access-devices-icon-btn access-devices-icon-btn-danger"
                      onClick={() => handleDelete(device)}
                      aria-label="Delete access device"
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}

            {filtered.length === 0 && (
              <tr>
                <td colSpan={16} className="access-devices-empty">
                  {devices.length === 0
                    ? 'No access devices yet. Click "+ Add Access Device" to create one.'
                    : 'No access devices match your search.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {modalState && (
        <AccessDeviceFormModal
          initial={modalState === 'new' ? null : modalState}
          onSave={handleSave}
          onClose={() => setModalState(null)}
        />
      )}

      {toast && <div className={`access-devices-toast access-devices-toast-${toast.type}`}>{toast.text}</div>}
    </div>
  );
}
