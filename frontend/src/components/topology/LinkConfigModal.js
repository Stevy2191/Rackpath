import React, { useEffect, useState } from 'react';
import { Cable, Waves, Spline, Wifi } from 'lucide-react';
import client from '../../api/client';
import './Modal.css';
import './LinkConfigModal.css';

const CABLE_TYPES = [
  { value: 'Copper (Cat6)', label: 'Copper (Cat6)', icon: Cable },
  { value: 'Multi-Mode Fibre', label: 'Multi-Mode Fibre', icon: Waves },
  { value: 'Single-Mode Fibre', label: 'Single-Mode Fibre', icon: Spline },
  { value: 'Wireless Link', label: 'Wireless Link', icon: Wifi },
];

const SPEEDS = ['100Mbps', '1Gbps', '10Gbps', '25Gbps', '40Gbps', '100Gbps'];

// Build the dropdown options: each top-level interface, with its VLAN
// sub-interfaces listed indented beneath it as "eth0.10 (VLAN 10)".
function buildInterfaceOptions(interfaces) {
  const mains = interfaces.filter((i) => !i.parent_id);
  const options = [];
  mains.forEach((m) => {
    if (m.name) options.push({ value: m.name, label: m.name });
    interfaces
      .filter((s) => s.parent_id === m.id)
      .forEach((s) => {
        const sub = `${m.name}.${s.vlan_id ?? ''}`;
        options.push({ value: sub, label: `  ${sub} (VLAN ${s.vlan_id ?? '?'})` });
      });
  });
  return options;
}

function InterfaceSelect({ deviceLabel, interfaces, value, onChange }) {
  const options = buildInterfaceOptions(interfaces);
  // Keep an already-saved value selectable even if it isn't in the list.
  const finalOptions = value && !options.some((o) => o.value === value) ? [{ value, label: value }, ...options] : options;

  return (
    <label className="link-config-port">
      <span className="link-config-port-label" title={deviceLabel}>
        {deviceLabel}
      </span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— select interface —</option>
        {finalOptions.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function LinkConfigModal({ sourceDevice, targetDevice, initialValues, onSubmit, onCancel }) {
  const isEdit = !!initialValues;
  const [cableType, setCableType] = useState(initialValues?.cable_type || 'Copper (Cat6)');
  const [sourceInterface, setSourceInterface] = useState(initialValues?.source_interface || '');
  const [targetInterface, setTargetInterface] = useState(initialValues?.target_interface || '');
  const [label, setLabel] = useState(initialValues?.label || '');
  const [vlan, setVlan] = useState(initialValues?.vlan || '');
  const [speed, setSpeed] = useState(initialValues?.speed || '');
  const [sourceIfaces, setSourceIfaces] = useState([]);
  const [targetIfaces, setTargetIfaces] = useState([]);

  useEffect(() => {
    let cancelled = false;
    async function loadInterfaces(deviceId, setter) {
      if (!deviceId) return;
      try {
        const res = await client.get(`/topology/nodes/${deviceId}/interfaces`);
        if (!cancelled) setter(res.data || []);
      } catch {
        if (!cancelled) setter([]);
      }
    }
    loadInterfaces(sourceDevice?.id, setSourceIfaces);
    loadInterfaces(targetDevice?.id, setTargetIfaces);
    return () => {
      cancelled = true;
    };
  }, [sourceDevice?.id, targetDevice?.id]);

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit({
      cable_type: cableType || null,
      source_interface: sourceInterface.trim() || null,
      target_interface: targetInterface.trim() || null,
      label: label.trim() || null,
      vlan: vlan.trim() || null,
      speed: speed || null,
    });
  };

  const sourceName = sourceDevice?.hostname || `Device ${sourceDevice?.id}`;
  const targetName = targetDevice?.hostname || `Device ${targetDevice?.id}`;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Link Configuration</h2>
        <form className="modal-form" onSubmit={handleSubmit}>
          <div className="link-config-cables">
            {CABLE_TYPES.map(({ value, label: cLabel, icon: Icon }) => (
              <button
                type="button"
                key={value}
                className={`link-config-cable${cableType === value ? ' selected' : ''}`}
                onClick={() => setCableType(value)}
              >
                <Icon size={26} strokeWidth={1.75} />
                <span>{cLabel}</span>
              </button>
            ))}
          </div>

          <div className="link-config-ports">
            <InterfaceSelect
              deviceLabel={sourceName}
              interfaces={sourceIfaces}
              value={sourceInterface}
              onChange={setSourceInterface}
            />
            <InterfaceSelect
              deviceLabel={targetName}
              interfaces={targetIfaces}
              value={targetInterface}
              onChange={setTargetInterface}
            />
          </div>

          <details className="link-config-more">
            <summary>Optional details</summary>
            <div className="link-config-more-grid">
              <label>
                Label
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Optional" />
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
            </div>
          </details>

          <div className="modal-actions">
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit">{isEdit ? 'Save Changes' : 'Confirm'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
