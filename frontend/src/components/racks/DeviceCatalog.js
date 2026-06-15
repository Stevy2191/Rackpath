import React, { useState } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import { RACK_CATALOG, CATALOG_CATEGORIES } from './rackCatalog';
import DeviceFacePlate from './DeviceFacePlate';
import CustomDeviceModal from './CustomDeviceModal';
import './DeviceCatalog.css';

// Find the lowest U position in `rack` (on the given face) where a block of
// `uSize` consecutive units is free.
function findNextFreeU(rack, allSlots, uSize, frontBack) {
  const occupied = new Set();
  for (const s of allSlots) {
    if (s.rack_id !== rack.id) continue;
    if ((s.front_back || 'front') !== frontBack) continue;
    for (let u = s.u_position; u <= s.u_position + s.u_size - 1; u++) occupied.add(u);
  }
  for (let start = 1; start + uSize - 1 <= rack.u_height; start++) {
    let free = true;
    for (let u = start; u <= start + uSize - 1; u++) {
      if (occupied.has(u)) {
        free = false;
        break;
      }
    }
    if (free) return start;
  }
  return null;
}

export default function DeviceCatalog({
  open,
  onClose,
  racks,
  allSlots,
  devices,
  rackCustomDevices,
  focusedRackId,
  actions,
  onCustomDeviceCreated,
  onCustomDeviceDeleted,
}) {
  const [category, setCategory] = useState('all');
  const [customDeviceModalOpen, setCustomDeviceModalOpen] = useState(false);

  if (!open) return null;

  const focusedRack = racks.find((r) => r.id === focusedRackId) || null;

  const rackedDeviceIds = new Set(allSlots.map((s) => s.device_id).filter(Boolean));
  const unrackedDevices = devices.filter((d) => !rackedDeviceIds.has(d.id));

  const entries = category === 'all' ? RACK_CATALOG : RACK_CATALOG.filter((e) => e.category === category);

  const previewSlot = (entry) => ({
    item_type: entry.renderType,
    custom_type: entry.renderType,
    u_size: entry.uSize,
    vendor: entry.vendor,
  });

  const addCatalogEntry = (entry) => {
    if (!focusedRack) return;
    const frontBack = entry.frontBack || 'front';
    const u_position = findNextFreeU(focusedRack, allSlots, entry.uSize, frontBack);
    if (u_position == null) return;
    const itemType = ['patch-panel', 'blank', 'cable-manager'].includes(entry.renderType) ? entry.renderType : 'custom-device';
    actions.onSlotCreate({
      rack_id: focusedRack.id,
      device_id: null,
      item_type: itemType,
      item_label: entry.name,
      vendor: entry.vendor,
      catalog_id: entry.id,
      custom_type: entry.renderType,
      u_position,
      u_size: entry.uSize,
      side: 'both',
      front_back: frontBack,
    });
  };

  const addCustomDevice = (custom) => {
    if (!focusedRack) return;
    const u_position = findNextFreeU(focusedRack, allSlots, custom.u_size, 'front');
    if (u_position == null) return;
    actions.onSlotCreate({
      rack_id: focusedRack.id,
      device_id: null,
      item_type: 'custom-device',
      item_label: custom.name,
      vendor: custom.vendor,
      custom_type: custom.type,
      custom_image_url: custom.image_url,
      u_position,
      u_size: custom.u_size,
      side: 'both',
      front_back: 'front',
    });
  };

  const addUnrackedDevice = (device) => {
    if (!focusedRack) return;
    const u_position = findNextFreeU(focusedRack, allSlots, 1, 'front');
    if (u_position == null) return;
    actions.onSlotCreate({
      rack_id: focusedRack.id,
      device_id: device.id,
      item_type: 'device',
      u_position,
      u_size: 1,
      side: 'both',
      front_back: 'front',
    });
  };

  return (
    <div className="device-catalog">
      <div className="device-catalog-header">
        <h3>Device Catalog</h3>
        <button type="button" className="device-catalog-close" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <p className="device-catalog-hint">
        {focusedRack
          ? `Click a card to add it to "${focusedRack.name}", or drag it onto any rack.`
          : 'Select a rack (click its badge) to enable click-to-add, or drag cards onto any rack.'}
      </p>

      <div className="device-catalog-tabs">
        {CATALOG_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            className={category === c.id ? 'active' : ''}
            onClick={() => setCategory(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="device-catalog-list">
        {category === 'all' && unrackedDevices.length > 0 && (
          <div className="device-catalog-section">
            <h4>Unracked Devices</h4>
            {unrackedDevices.map((device) => (
              <div
                key={device.id}
                className="device-catalog-card device-catalog-card-simple"
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/device-id', String(device.id))}
                onClick={() => addUnrackedDevice(device)}
              >
                <div className="device-catalog-card-info">
                  <span className="device-catalog-card-name">{device.hostname || device.ip || `Device ${device.id}`}</span>
                  <span className="device-catalog-card-meta">{device.type || 'Device'} · 1U</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {category === 'custom' ? (
          <div className="device-catalog-section">
            <h4>Custom Devices</h4>
            {rackCustomDevices.map((custom) => (
              <div
                key={custom.id}
                className="device-catalog-card"
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/custom-device-id', String(custom.id))}
                onClick={() => addCustomDevice(custom)}
              >
                <div className="device-catalog-card-preview">
                  {custom.image_url ? (
                    <img src={custom.image_url} alt={custom.name} />
                  ) : (
                    <DeviceFacePlate
                      slot={{ item_type: custom.type, custom_type: custom.type, u_size: custom.u_size }}
                      side="front"
                    />
                  )}
                </div>
                <div className="device-catalog-card-info">
                  <span className="device-catalog-card-name">{custom.name}</span>
                  <span className="device-catalog-card-meta">
                    {custom.vendor || 'Custom'} · {custom.u_size}U
                  </span>
                </div>
                <button
                  type="button"
                  className="device-catalog-card-delete"
                  title="Delete custom device"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCustomDeviceDeleted(custom.id);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            {rackCustomDevices.length === 0 && <p className="device-catalog-empty">No custom devices yet.</p>}
            <button type="button" className="device-catalog-add-custom" onClick={() => setCustomDeviceModalOpen(true)}>
              <Plus size={14} /> Add Custom Device
            </button>
          </div>
        ) : (
          <div className="device-catalog-section">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="device-catalog-card"
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/catalog-item', JSON.stringify(entry))}
                onClick={() => addCatalogEntry(entry)}
              >
                <div className="device-catalog-card-preview">
                  <DeviceFacePlate slot={previewSlot(entry)} side={entry.frontBack} />
                </div>
                <div className="device-catalog-card-info">
                  <span className="device-catalog-card-name">{entry.name}</span>
                  <span className="device-catalog-card-meta">
                    {entry.vendor} · {entry.uSize}U{entry.frontBack === 'back' ? ' · Rear' : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {customDeviceModalOpen && (
        <CustomDeviceModal
          onClose={() => setCustomDeviceModalOpen(false)}
          onCreated={(custom) => {
            onCustomDeviceCreated(custom);
            setCustomDeviceModalOpen(false);
          }}
        />
      )}
    </div>
  );
}
