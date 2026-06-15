import React, { useEffect, useState } from 'react';
import client from '../../api/client';
import './Modal.css';
import './LinkConfigModal.css';

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
        options.push({ value: sub, label: `  ${sub} (VLAN ${s.vlan_id ?? '?'})` });
      });
  });
  return options;
}

function InterfaceSelect({ deviceLabel, interfaces, value, onChange, listId }) {
  const options = buildInterfaceOptions(interfaces);

  return (
    <label className="link-config-port">
      <span className="link-config-port-label" title={deviceLabel}>
        {deviceLabel}
      </span>
      <input
        type="text"
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. eth0"
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o.value} value={o.value} label={o.label} />
        ))}
      </datalist>
    </label>
  );
}

export default function LinkConfigModal({ sourceDevice, targetDevice, initialValues, onSubmit, onCancel }) {
  const isEdit = !!initialValues;
  const [sourceInterface, setSourceInterface] = useState(initialValues?.source_interface || '');
  const [targetInterface, setTargetInterface] = useState(initialValues?.target_interface || '');
  const [label, setLabel] = useState(initialValues?.label || '');
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

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit({
      source_interface: sourceInterface.trim() || null,
      target_interface: targetInterface.trim() || null,
      label: label.trim() || null,
    });
  };

  const sourceName = sourceDevice?.hostname || `Device ${sourceDevice?.id}`;
  const targetName = targetDevice?.hostname || `Device ${targetDevice?.id}`;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Link Configuration</h2>
        <form className="modal-form" onSubmit={handleSubmit}>
          <div className="link-config-ports">
            <InterfaceSelect
              deviceLabel={sourceName}
              interfaces={sourceIfaces}
              value={sourceInterface}
              onChange={setSourceInterface}
              listId="link-config-source-ifaces"
            />
            <InterfaceSelect
              deviceLabel={targetName}
              interfaces={targetIfaces}
              value={targetInterface}
              onChange={setTargetInterface}
              listId="link-config-target-ifaces"
            />
          </div>

          <label>
            Label
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Optional" />
          </label>

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
