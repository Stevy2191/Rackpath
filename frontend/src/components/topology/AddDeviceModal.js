import React, { useState } from 'react';
import { DEVICE_TYPES } from './deviceTypes';
import './Modal.css';

export default function AddDeviceModal({ deviceType, onSubmit, onCancel }) {
  const [hostname, setHostname] = useState('');
  const [ip, setIp] = useState('');

  const info = DEVICE_TYPES[deviceType] || DEVICE_TYPES.unknown;

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit({ hostname: hostname.trim() || null, ip: ip.trim() || null });
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-small" onClick={(e) => e.stopPropagation()}>
        <h2>
          {info.icon} Add {info.label}
        </h2>
        <form className="modal-form" onSubmit={handleSubmit}>
          <label>
            Hostname
            <input
              autoFocus
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="Optional"
            />
          </label>
          <label>
            IP Address
            <input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="Optional" />
          </label>
          <div className="modal-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit">Add</button>
          </div>
        </form>
      </div>
    </div>
  );
}
