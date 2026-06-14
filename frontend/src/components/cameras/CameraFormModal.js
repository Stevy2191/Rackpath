import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import '../topology/Modal.css';
import './CameraFormModal.css';

export const emptyCamera = {
  name: '',
  model: '',
  mac: '',
  ip_address: '',
  rtsp_url: '',
  rtsps_url: '',
  stream_password: '',
  username: '',
  resolution: '',
  location_notes: '',
  status: 'unknown',
};

function MaskedField({ label, value, onChange, placeholder }) {
  const [visible, setVisible] = useState(false);
  return (
    <label>
      {label}
      <div className="camera-masked-field">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          autoComplete="off"
        />
        <button
          type="button"
          className="camera-masked-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide' : 'Show'}
          title={visible ? 'Hide' : 'Show'}
        >
          {visible ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
    </label>
  );
}

export default function CameraFormModal({ initial, onSave, onClose }) {
  const [draft, setDraft] = useState(initial || emptyCamera);
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
      await onSave(draft);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-small" onClick={(e) => e.stopPropagation()}>
        <h2>{initial ? 'Edit Camera' : 'Add Camera'}</h2>

        {error && <div className="integration-form-error">{error}</div>}

        <form onSubmit={handleSubmit} className="modal-form">
          <label>
            Name
            <input value={draft.name} onChange={field('name')} placeholder="e.g. Front Door" autoFocus required />
          </label>
          <label>
            Model
            <input value={draft.model || ''} onChange={field('model')} placeholder="e.g. G4 Bullet" />
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
            Resolution
            <input value={draft.resolution || ''} onChange={field('resolution')} placeholder="1920x1080" />
          </label>
          <label>
            Username
            <input value={draft.username || ''} onChange={field('username')} />
          </label>
          <MaskedField label="RTSP URL" value={draft.rtsp_url || ''} onChange={field('rtsp_url')} placeholder="rtsp://192.168.1.1:7447/alias" />
          <MaskedField
            label="RTSPS URL"
            value={draft.rtsps_url || ''}
            onChange={field('rtsps_url')}
            placeholder="rtsps://192.168.1.1:7441/alias"
          />
          <MaskedField label="Stream Password" value={draft.stream_password || ''} onChange={field('stream_password')} />
          <label>
            Status
            <select value={draft.status || 'unknown'} onChange={field('status')}>
              <option value="unknown">Unknown</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
            </select>
          </label>
          <label>
            Location Notes
            <input value={draft.location_notes || ''} onChange={field('location_notes')} placeholder="e.g. Rack 3, top shelf" />
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
