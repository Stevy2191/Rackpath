import React, { useState } from 'react';
import { powerSourceCatalogEntries } from './rackCatalog';

export default function VerticalPduModal({ rack, rackCustomDevices, onClose, onCreate }) {
  const customPowerDevices = rackCustomDevices.filter((c) => c.type === 'ups' || c.type === 'pdu');
  const catalogEntries = powerSourceCatalogEntries();

  const [sourceKey, setSourceKey] = useState(catalogEntries[0] ? `catalog:${catalogEntries[0].id}` : '');
  const [side, setSide] = useState('left');
  const [startU, setStartU] = useState(1);
  const [spanU, setSpanU] = useState(rack.u_height);
  const [error, setError] = useState(null);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!sourceKey) { setError('Choose a PDU/UPS to place'); return; }
    if (startU < 1 || spanU < 1 || startU + spanU - 1 > rack.u_height) {
      setError('Start/span must fit within the rack height');
      return;
    }

    const [kind, idRaw] = sourceKey.split(':');
    let payload;
    if (kind === 'catalog') {
      const entry = catalogEntries.find((c) => c.id === idRaw);
      if (!entry) return;
      payload = {
        item_label: entry.name,
        vendor: entry.vendor,
        catalog_id: entry.id,
        custom_type: entry.renderType,
        power_draw_w: entry.powerDrawW,
        outlet_count: entry.outletCount,
        outlet_type: entry.outletType,
        power_capacity: entry.capacity,
        power_capacity_unit: entry.capacityUnit,
        input_voltage: entry.inputVoltage,
      };
    } else {
      const custom = customPowerDevices.find((c) => String(c.id) === idRaw);
      if (!custom) return;
      payload = {
        item_label: custom.name,
        vendor: custom.vendor,
        custom_type: custom.type,
        custom_image_url: custom.image_url,
        power_draw_w: custom.power_draw_w,
        outlet_count: custom.outlet_count,
        outlet_type: custom.outlet_type,
        power_capacity: custom.power_capacity,
        power_capacity_unit: custom.power_capacity_unit,
        input_voltage: custom.input_voltage,
      };
    }

    onCreate({
      rack_id: rack.id,
      item_type: 'vertical-pdu',
      mount_side: side,
      u_position: Number(startU),
      u_size: Number(spanU),
      ...payload,
    });
  };

  return (
    <div className="rack-modal-overlay" onMouseDown={onClose}>
      <div className="rack-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Add Vertical PDU</h3>
        <form onSubmit={handleSubmit}>
          <label>
            Device
            <select value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
              {catalogEntries.length > 0 && (
                <optgroup label="Catalog">
                  {catalogEntries.map((c) => (
                    <option key={c.id} value={`catalog:${c.id}`}>{c.vendor} {c.name}</option>
                  ))}
                </optgroup>
              )}
              {customPowerDevices.length > 0 && (
                <optgroup label="Custom">
                  {customPowerDevices.map((c) => (
                    <option key={c.id} value={`custom:${c.id}`}>{c.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <label>
            Side
            <select value={side} onChange={(e) => setSide(e.target.value)}>
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </label>
          <label>
            Start U
            <input
              type="number"
              min="1"
              max={rack.u_height}
              value={startU}
              onChange={(e) => setStartU(Number(e.target.value))}
            />
          </label>
          <label>
            Span (U)
            <input
              type="number"
              min="1"
              max={rack.u_height}
              value={spanU}
              onChange={(e) => setSpanU(Number(e.target.value))}
            />
          </label>

          {error && <div className="rack-modal-error">{error}</div>}

          <div className="rack-modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="rack-modal-save">Add</button>
          </div>
        </form>
      </div>
    </div>
  );
}
