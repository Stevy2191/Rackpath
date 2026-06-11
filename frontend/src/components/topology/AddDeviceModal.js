import React, { useState } from 'react';
import { DEVICE_TYPES, customIconFilename, customIconUrl } from './deviceTypes';
import './Modal.css';

export default function AddDeviceModal({ deviceInfo, onSubmit, onCancel }) {
  const [hostname, setHostname] = useState('');
  const [ip, setIp] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit({ hostname: hostname.trim() || null, ip: ip.trim() || null });
  };

  const Icon = !deviceInfo.isCustom ? DEVICE_TYPES[deviceInfo.type]?.icon : null;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-small" onClick={(e) => e.stopPropagation()}>
        <h2>
          {deviceInfo.isCustom ? (
            <img className="modal-title-icon" src={customIconUrl(customIconFilename(deviceInfo.type))} alt="" />
          ) : (
            Icon && <Icon size={20} strokeWidth={2} className="modal-title-icon-svg" />
          )}{' '}
          Add {deviceInfo.label}
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
