import React, { useState } from 'react';
import './Modal.css';

const SPEEDS = ['100Mbps', '1Gbps', '10Gbps', '25Gbps', '40Gbps', '100Gbps'];
const CABLE_TYPES = ['Cat5e', 'Cat6', 'Cat6a', 'Fiber', 'DAC'];

export default function ConnectionModal({ initialValues, onSubmit, onCancel }) {
  const isEdit = !!initialValues;
  const [label, setLabel] = useState(initialValues?.label || '');
  const [vlan, setVlan] = useState(initialValues?.vlan || '');
  const [speed, setSpeed] = useState(initialValues?.speed || '');
  const [cableType, setCableType] = useState(initialValues?.cable_type || '');
  const [sourceInterface, setSourceInterface] = useState(initialValues?.source_interface || '');
  const [targetInterface, setTargetInterface] = useState(initialValues?.target_interface || '');

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit({
      label: label.trim() || null,
      vlan: vlan.trim() || null,
      speed: speed || null,
      cable_type: cableType || null,
      source_interface: sourceInterface.trim() || null,
      target_interface: targetInterface.trim() || null,
    });
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal-small" onClick={(e) => e.stopPropagation()}>
        <h2>{isEdit ? 'Edit Connection' : 'New Connection'}</h2>
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
            Source Interface
            <input
              value={sourceInterface}
              onChange={(e) => setSourceInterface(e.target.value)}
              placeholder="e.g. Gi0/1"
            />
          </label>
          <label>
            Target Interface
            <input
              value={targetInterface}
              onChange={(e) => setTargetInterface(e.target.value)}
              placeholder="e.g. eth0"
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
            <button type="submit">{isEdit ? 'Save Changes' : 'Add Connection'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
