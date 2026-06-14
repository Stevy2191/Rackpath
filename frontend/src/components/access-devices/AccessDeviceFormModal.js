import React, { useState } from 'react';
import '../topology/Modal.css';
import './AccessDeviceFormModal.css';

export const emptyAccessDevice = {
  name: '',
  device_type: '',
  model: '',
  mac: '',
  ip_address: '',
  firmware_version: '',
  door_name: '',
  location: '',
  floor: '',
  online: false,
  door_lock_state: 'unknown',
  door_open_state: 'unknown',
  connected_readers: [],
  access_groups: [],
  unlock_schedules: [],
};

const DEVICE_TYPES = [
  { value: '', label: 'Unknown' },
  { value: 'ua-hub', label: 'UA Hub' },
  { value: 'ua-pro', label: 'UA Pro' },
  { value: 'ua-g2', label: 'UA G2' },
  { value: 'ua-g2-mini', label: 'UA G2 Mini' },
  { value: 'ua-intercom', label: 'UA Intercom' },
  { value: 'ua-elevator', label: 'UA Elevator' },
  { value: 'ua-reader', label: 'UA Reader' },
  { value: 'ua-reader-lite', label: 'UA Reader Lite' },
  { value: 'ua-door-controller', label: 'UA Door Controller' },
  { value: 'other', label: 'Other' },
];

// Comma-separated text fields for the list-valued columns (connected_readers,
// access_groups, unlock_schedules), converted to/from arrays on load/save.
function toListText(value) {
  return Array.isArray(value) ? value.join(', ') : '';
}

function fromListText(value) {
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function initDraft(initial) {
  const base = initial || emptyAccessDevice;
  return {
    ...emptyAccessDevice,
    ...base,
    connected_readers: toListText(base.connected_readers),
    access_groups: toListText(base.access_groups),
    unlock_schedules: toListText(base.unlock_schedules),
  };
}

export default function AccessDeviceFormModal({ initial, onSave, onClose }) {
  const [draft, setDraft] = useState(() => initDraft(initial));
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
      await onSave({
        ...draft,
        connected_readers: fromListText(draft.connected_readers),
        access_groups: fromListText(draft.access_groups),
        unlock_schedules: fromListText(draft.unlock_schedules),
      });
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-small" onClick={(e) => e.stopPropagation()}>
        <h2>{initial ? 'Edit Access Device' : 'Add Access Device'}</h2>

        {error && <div className="integration-form-error">{error}</div>}

        <form onSubmit={handleSubmit} className="modal-form">
          <label>
            Name
            <input value={draft.name} onChange={field('name')} placeholder="e.g. Front Door Hub" autoFocus required />
          </label>
          <label>
            Device Type
            <select value={draft.device_type || ''} onChange={field('device_type')}>
              {DEVICE_TYPES.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model
            <input value={draft.model || ''} onChange={field('model')} placeholder="e.g. UA Hub" />
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
            Firmware Version
            <input value={draft.firmware_version || ''} onChange={field('firmware_version')} />
          </label>
          <label>
            Door Name
            <input value={draft.door_name || ''} onChange={field('door_name')} placeholder="e.g. Front Entrance" />
          </label>
          <label>
            Location
            <input value={draft.location || ''} onChange={field('location')} placeholder="e.g. Building A" />
          </label>
          <label>
            Floor
            <input value={draft.floor || ''} onChange={field('floor')} placeholder="e.g. 1st Floor" />
          </label>
          <label>
            Lock State
            <select value={draft.door_lock_state || 'unknown'} onChange={field('door_lock_state')}>
              <option value="unknown">Unknown</option>
              <option value="locked">Locked</option>
              <option value="unlocked">Unlocked</option>
            </select>
          </label>
          <label>
            Door State
            <select value={draft.door_open_state || 'unknown'} onChange={field('door_open_state')}>
              <option value="unknown">Unknown</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
            </select>
          </label>
          <label>
            Connected Readers
            <input
              value={draft.connected_readers}
              onChange={field('connected_readers')}
              placeholder="Reader 1, Reader 2"
            />
          </label>
          <label>
            Access Groups
            <input value={draft.access_groups} onChange={field('access_groups')} placeholder="Employees, Visitors" />
          </label>
          <label>
            Unlock Schedules
            <input value={draft.unlock_schedules} onChange={field('unlock_schedules')} placeholder="Business Hours" />
          </label>
          <label className="access-device-checkbox-label">
            <input
              type="checkbox"
              checked={!!draft.online}
              onChange={(e) => setDraft((prev) => ({ ...prev, online: e.target.checked }))}
            />
            Online
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
