import React, { useState } from 'react';
import './Modal.css';

const SPEEDS = ['100Mbps', '1Gbps', '10Gbps', '25Gbps', '40Gbps', '100Gbps'];
const CABLE_TYPES = ['Cat5e', 'Cat6', 'Cat6a', 'Fiber', 'DAC'];

export default function ConnectionModal({ onSubmit, onCancel }) {
  const [label, setLabel] = useState('');
  const [vlan, setVlan] = useState('');
  const [speed, setSpeed] = useState('');
  const [cableType, setCableType] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit({
      label: label.trim() || null,
      vlan: vlan.trim() || null,
      speed: speed || null,
      cable_type: cableType || null,
    });
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-small" onClick={(e) => e.stopPropagation()}>
        <h2>New Connection</h2>
        <form className="modal-form" onSubmit={handleSubmit}>
          <label>
            Label
            <input
              autoFocus
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Optional"
            />
          </label>
          <label>
            VLAN
            <input value={vlan} onChange={(e) => setVlan(e.target.value)} placeholder="Optional" />
          </label>
          <label>
            Speed
            <select value={speed} onChange={(e) => setSpeed(e.target.value)}>
              <option value="">-</option>
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Cable Type
            <select value={cableType} onChange={(e) => setCableType(e.target.value)}>
              <option value="">-</option>
              {CABLE_TYPES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <div className="modal-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit">Add Connection</button>
          </div>
        </form>
      </div>
    </div>
  );
}
