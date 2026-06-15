import React, { useState } from 'react';
import client from '../../api/client';

const CUSTOM_DEVICE_TYPES = [
  { value: 'switch', label: 'Switch' },
  { value: 'server', label: 'Server' },
  { value: 'firewall', label: 'Firewall / Router' },
  { value: 'storage', label: 'Storage' },
  { value: 'ups', label: 'UPS' },
  { value: 'pdu', label: 'PDU' },
  { value: 'patch-panel', label: 'Patch Panel' },
  { value: 'cable-manager', label: 'Cable Manager' },
  { value: 'blank', label: 'Blank Panel' },
  { value: 'kvm', label: 'KVM' },
  { value: 'ap', label: 'Access Point' },
  { value: 'other', label: 'Other' },
];

const empty = { name: '', vendor: '', type: 'other', u_size: 1 };

export default function CustomDeviceModal({ onClose, onCreated }) {
  const [form, setForm] = useState(empty);
  const [image, setImage] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const data = new FormData();
      data.append('name', form.name.trim());
      data.append('vendor', form.vendor.trim());
      data.append('type', form.type);
      data.append('u_size', String(form.u_size));
      if (image) data.append('image', image);

      const res = await client.post('/rack-custom-devices', data, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      onCreated(res.data);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setSaving(false);
    }
  };

  return (
    <div className="rack-modal-overlay" onMouseDown={onClose}>
      <div className="rack-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Add Custom Device</h3>
        <form onSubmit={handleSubmit}>
          <label>
            Name
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Device name"
              autoFocus
              required
            />
          </label>
          <label>
            Vendor
            <input
              value={form.vendor}
              onChange={(e) => setForm({ ...form, vendor: e.target.value })}
              placeholder="e.g. Acme Corp"
            />
          </label>
          <label>
            Type
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {CUSTOM_DEVICE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            U Size
            <input
              type="number"
              min="1"
              value={form.u_size}
              onChange={(e) => setForm({ ...form, u_size: Math.max(1, Number(e.target.value)) })}
            />
          </label>
          <label>
            Image (optional)
            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => setImage(e.target.files[0] || null)} />
          </label>

          {error && <div className="rack-modal-error">{error}</div>}

          <div className="rack-modal-actions">
            <button type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="rack-modal-save" disabled={saving}>
              {saving ? 'Saving...' : 'Add Device'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
