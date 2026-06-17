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

const empty = {
  name: '', vendor: '', type: 'other', u_size: 1,
  power_draw_w: '', outlet_count: '', outlet_type: '', power_capacity: '', power_capacity_unit: 'W', input_voltage: '',
};

const VOLTAGE_OPTIONS = ['120V', '208V', '240V'];

export default function CustomDeviceModal({ onClose, onCreated }) {
  const [form, setForm] = useState(empty);
  const [image, setImage] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const isPowerDevice = form.type === 'ups' || form.type === 'pdu';

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
      if (form.power_draw_w !== '') data.append('power_draw_w', form.power_draw_w);
      if (isPowerDevice) {
        if (form.outlet_count !== '') data.append('outlet_count', form.outlet_count);
        if (form.outlet_type) data.append('outlet_type', form.outlet_type);
        if (form.power_capacity !== '') data.append('power_capacity', form.power_capacity);
        data.append('power_capacity_unit', form.power_capacity_unit);
        if (form.input_voltage) data.append('input_voltage', form.input_voltage);
      }
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
          <label>
            Power Draw (Watts, optional)
            <input
              type="number"
              min="0"
              value={form.power_draw_w}
              onChange={(e) => setForm({ ...form, power_draw_w: e.target.value })}
              placeholder="e.g. 350"
            />
          </label>

          {isPowerDevice && (
            <>
              <label>
                Outlet Count
                <input
                  type="number"
                  min="0"
                  value={form.outlet_count}
                  onChange={(e) => setForm({ ...form, outlet_count: e.target.value })}
                  placeholder="e.g. 8"
                />
              </label>
              <label>
                Outlet Type
                <input
                  value={form.outlet_type}
                  onChange={(e) => setForm({ ...form, outlet_type: e.target.value })}
                  placeholder="e.g. NEMA 5-15R, C13, C19"
                />
              </label>
              <label>
                Capacity
                <input
                  type="number"
                  min="0"
                  value={form.power_capacity}
                  onChange={(e) => setForm({ ...form, power_capacity: e.target.value })}
                  placeholder="e.g. 1500"
                />
              </label>
              <label>
                Capacity Unit
                <select
                  value={form.power_capacity_unit}
                  onChange={(e) => setForm({ ...form, power_capacity_unit: e.target.value })}
                >
                  <option value="W">Watts (W)</option>
                  <option value="VA">Volt-Amps (VA)</option>
                </select>
              </label>
              <label>
                Input Voltage
                <select
                  value={form.input_voltage}
                  onChange={(e) => setForm({ ...form, input_voltage: e.target.value })}
                >
                  <option value="">Unset</option>
                  {VOLTAGE_OPTIONS.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </label>
            </>
          )}

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
