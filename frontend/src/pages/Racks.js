import React, { useEffect, useRef, useState } from 'react';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';
import client from '../api/client';
import PortEditorModal from '../components/PortEditorModal';
import { COLOR_SWATCHES } from '../components/topology/deviceTypes';
import './Racks.css';

const RACK_TYPES = [
  { value: '4-post', label: '4-Post Rack' },
  { value: '2-post', label: '2-Post Rack' },
  { value: 'wall-mount', label: 'Wall Mount' },
  { value: 'open-frame', label: 'Open Frame' },
  { value: 'blade-enclosure', label: 'Blade Enclosure' },
];

const RACK_ITEM_PALETTE = [
  { item_type: 'patch-panel', label: 'Patch Panel', u_size: 1 },
  { item_type: 'blank', label: 'Blank Panel', u_size: 1 },
  { item_type: 'cable-manager', label: 'Cable Manager', u_size: 1 },
];

const SIDE_OPTIONS = [
  { value: 'front', label: 'Front' },
  { value: 'back', label: 'Back' },
  { value: 'both', label: 'Both' },
];

const ITEM_TYPE_LABELS = {
  'patch-panel': 'Patch Panel',
  blank: 'Blank',
  'cable-manager': 'Cable Manager',
};

const CUSTOM_DEVICE_TYPES = [
  'Server',
  'Switch',
  'Router',
  'Firewall',
  'Patch Panel',
  'Cable Manager',
  'Blank Panel',
  'UPS',
  'KVM',
  'Other',
];

const emptyRack = { name: '', location: '', u_height: 42, rack_type: '4-post', notes: '' };

const emptyCustomDevice = { name: '', type: CUSTOM_DEVICE_TYPES[0], u_size: 1, color: COLOR_SWATCHES[0].hex };

export default function RacksPage() {
  const [racks, setRacks] = useState([]);
  const [devices, setDevices] = useState([]);
  const [allSlots, setAllSlots] = useState([]);
  const [selectedRackId, setSelectedRackId] = useState(null);
  const [selectedRack, setSelectedRack] = useState(null);
  const [rackEdits, setRackEdits] = useState(emptyRack);
  const [newRack, setNewRack] = useState(emptyRack);
  const [portEditorDevice, setPortEditorDevice] = useState(null);
  const [error, setError] = useState(null);
  const [selectedSide, setSelectedSide] = useState('front');
  const [exporting, setExporting] = useState(false);
  const [customDevice, setCustomDevice] = useState(emptyCustomDevice);
  const rackFrameRef = useRef(null);

  const loadRacks = () => {
    client.get('/racks').then((res) => setRacks(res.data)).catch((err) => setError(err.message));
  };

  const loadDevices = () => {
    client.get('/devices').then((res) => setDevices(res.data)).catch((err) => setError(err.message));
  };

  const loadAllSlots = () => {
    client.get('/rack-slots').then((res) => setAllSlots(res.data)).catch((err) => setError(err.message));
  };

  const loadSelectedRack = (id) => {
    if (!id) {
      setSelectedRack(null);
      return;
    }
    client
      .get(`/racks/${id}`)
      .then((res) => {
        setSelectedRack(res.data);
        setRackEdits({
          name: res.data.name,
          location: res.data.location || '',
          u_height: res.data.u_height,
          rack_type: res.data.rack_type || '4-post',
          notes: res.data.notes || '',
        });
      })
      .catch((err) => setError(err.message));
  };

  const refreshRackData = (rackId) => {
    loadAllSlots();
    loadSelectedRack(rackId);
  };

  useEffect(() => {
    loadRacks();
    loadDevices();
    loadAllSlots();
  }, []);

  useEffect(() => {
    loadSelectedRack(selectedRackId);
  }, [selectedRackId]);

  const handleCreateRack = async (e) => {
    e.preventDefault();
    try {
      const res = await client.post('/racks', newRack);
      setNewRack(emptyRack);
      loadRacks();
      setSelectedRackId(res.data.id);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleSaveRack = async (e) => {
    e.preventDefault();
    if (!selectedRack) return;
    try {
      await client.put(`/racks/${selectedRack.id}`, rackEdits);
      loadRacks();
      loadSelectedRack(selectedRack.id);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleDeleteRack = async () => {
    if (!selectedRack) return;
    try {
      await client.delete(`/racks/${selectedRack.id}`);
      setSelectedRackId(null);
      loadRacks();
      loadAllSlots();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleUpdateSlot = async (slot, changes) => {
    try {
      await client.put(`/rack-slots/${slot.id}`, {
        rack_id: slot.rack_id,
        device_id: slot.device_id,
        item_type: slot.item_type,
        item_label: slot.item_label,
        custom_type: slot.custom_type,
        color: slot.color,
        u_position: slot.u_position,
        u_size: slot.u_size,
        side: slot.side,
        ...changes,
      });
      refreshRackData(selectedRack.id);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleDrop = async (uPosition, e) => {
    e.preventDefault();
    if (!selectedRack) return;

    const slotId = e.dataTransfer.getData('text/slot-id');
    const deviceId = e.dataTransfer.getData('text/device-id');
    const rackItemType = e.dataTransfer.getData('text/rack-item-type');
    const customDeviceData = e.dataTransfer.getData('text/custom-device');

    try {
      if (slotId) {
        const slot = selectedRack.slots.find((s) => String(s.id) === slotId);
        if (!slot) return;
        const newUPosition = uPosition - slot.u_size + 1;
        if (newUPosition === slot.u_position) return;
        await handleUpdateSlot(slot, { u_position: newUPosition });
        return;
      } else if (deviceId) {
        await client.post('/rack-slots', {
          rack_id: selectedRack.id,
          device_id: Number(deviceId),
          item_type: 'device',
          u_position: uPosition,
          u_size: 1,
          side: 'both',
        });
      } else if (rackItemType) {
        const itemLabel = e.dataTransfer.getData('text/rack-item-label') || ITEM_TYPE_LABELS[rackItemType];
        const itemUSize = Number(e.dataTransfer.getData('text/rack-item-usize')) || 1;
        await client.post('/rack-slots', {
          rack_id: selectedRack.id,
          device_id: null,
          item_type: rackItemType,
          item_label: itemLabel,
          u_position: uPosition,
          u_size: itemUSize,
          side: 'both',
        });
      } else if (customDeviceData) {
        const custom = JSON.parse(customDeviceData);
        await client.post('/rack-slots', {
          rack_id: selectedRack.id,
          device_id: null,
          item_type: 'custom-device',
          item_label: custom.name,
          custom_type: custom.type,
          color: custom.color,
          u_position: uPosition,
          u_size: custom.u_size,
          side: 'both',
        });
      } else {
        return;
      }
      refreshRackData(selectedRack.id);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleRemoveSlot = async (slotId) => {
    try {
      await client.delete(`/rack-slots/${slotId}`);
      refreshRackData(selectedRack.id);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleResizeSlot = (slot, uSize) => {
    if (uSize < 1) return;
    handleUpdateSlot(slot, { u_size: uSize });
  };

  const handleSlotSideChange = (slot, newSide) => {
    handleUpdateSlot(slot, { side: newSide });
  };

  const handleItemLabelChange = (slot, newLabel) => {
    if (newLabel === (slot.item_label || '')) return;
    handleUpdateSlot(slot, { item_label: newLabel });
  };

  const handleCustomTypeChange = (slot, newType) => {
    handleUpdateSlot(slot, { custom_type: newType });
  };

  const handleCustomColorChange = (slot, newColor) => {
    handleUpdateSlot(slot, { color: newColor });
  };

  const handleExport = async (format) => {
    if (!rackFrameRef.current || !selectedRack) return;
    setExporting(true);
    try {
      const el = rackFrameRef.current;
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const backgroundColor =
        getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim() || '#ffffff';
      const dataUrl = await toPng(el, { backgroundColor, width, height });
      const filename = selectedRack.name.trim().replace(/\s+/g, '-').toLowerCase() || 'rack';

      if (format === 'pdf') {
        const orientation = width >= height ? 'landscape' : 'portrait';
        const pdf = new jsPDF({ orientation, unit: 'px', format: [width, height] });
        pdf.addImage(dataUrl, 'PNG', 0, 0, width, height);
        pdf.save(`rack-${filename}.pdf`);
      } else {
        const link = document.createElement('a');
        link.download = `rack-${filename}.png`;
        link.href = dataUrl;
        link.click();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  };

  const rackedDeviceIds = new Set(allSlots.map((slot) => slot.device_id).filter(Boolean));
  const unrackedDevices = devices.filter((d) => !rackedDeviceIds.has(d.id));

  // Map each U position covered by a slot (visible on the selected side) to
  // that slot, and track the "top" position (u_position + u_size - 1) where
  // the device block starts.
  const slotsByTopPosition = {};
  const coveredPositions = new Set();
  if (selectedRack) {
    for (const slot of selectedRack.slots) {
      if (slot.side !== selectedSide && slot.side !== 'both') continue;
      const top = slot.u_position + slot.u_size - 1;
      slotsByTopPosition[top] = slot;
      for (let u = slot.u_position; u <= top; u++) {
        coveredPositions.add(u);
      }
    }
  }

  const uRows = selectedRack
    ? Array.from({ length: selectedRack.u_height }, (_, i) => selectedRack.u_height - i)
    : [];

  return (
    <div className="racks-page">
      {error && <div className="page-error">{error}</div>}

      <aside className="racks-sidebar">
        <h2>Racks</h2>
        <ul className="rack-list">
          {racks.map((rack) => (
            <li key={rack.id}>
              <button
                className={rack.id === selectedRackId ? 'active' : ''}
                onClick={() => setSelectedRackId(rack.id)}
              >
                {rack.name} ({rack.u_height}U)
              </button>
            </li>
          ))}
        </ul>

        <form onSubmit={handleCreateRack} className="rack-form">
          <h3>New Rack</h3>
          <input
            placeholder="Name"
            value={newRack.name}
            onChange={(e) => setNewRack({ ...newRack, name: e.target.value })}
            required
          />
          <input
            placeholder="Location"
            value={newRack.location}
            onChange={(e) => setNewRack({ ...newRack, location: e.target.value })}
          />
          <input
            type="number"
            min="4"
            max="52"
            placeholder="U Height"
            value={newRack.u_height}
            onChange={(e) => setNewRack({ ...newRack, u_height: Number(e.target.value) })}
          />
          <select
            value={newRack.rack_type}
            onChange={(e) => setNewRack({ ...newRack, rack_type: e.target.value })}
          >
            {RACK_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <button type="submit">Add Rack</button>
        </form>

        <h3>Unracked Devices</h3>
        <p className="hint">Drag a device onto a U slot to mount it.</p>
        <ul className="device-list">
          {unrackedDevices.map((device) => (
            <li
              key={device.id}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/device-id', String(device.id))}
            >
              {device.hostname || device.ip || `Device ${device.id}`}
            </li>
          ))}
          {unrackedDevices.length === 0 && <li className="hint">All devices are racked.</li>}
        </ul>

        <h3>Rack Items</h3>
        <p className="hint">Drag onto a U slot to add patch panels, blanks, or cable managers.</p>
        <ul className="rack-item-palette">
          {RACK_ITEM_PALETTE.map((item) => (
            <li
              key={item.item_type}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/rack-item-type', item.item_type);
                e.dataTransfer.setData('text/rack-item-label', item.label);
                e.dataTransfer.setData('text/rack-item-usize', String(item.u_size));
              }}
            >
              {item.label}
            </li>
          ))}
        </ul>

        <h3>Add Custom Device</h3>
        <p className="hint">Fill in the details, then drag the preview onto a U slot.</p>
        <div className="custom-device-form">
          <input
            placeholder="Name"
            value={customDevice.name}
            onChange={(e) => setCustomDevice({ ...customDevice, name: e.target.value })}
          />
          <select
            value={customDevice.type}
            onChange={(e) => setCustomDevice({ ...customDevice, type: e.target.value })}
          >
            {CUSTOM_DEVICE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            type="number"
            min="1"
            placeholder="U Size"
            value={customDevice.u_size}
            onChange={(e) => setCustomDevice({ ...customDevice, u_size: Math.max(1, Number(e.target.value)) })}
          />
          <div className="custom-device-swatches">
            {COLOR_SWATCHES.map((c) => (
              <button
                key={c.hex}
                type="button"
                className={`custom-device-swatch ${customDevice.color === c.hex ? 'active' : ''}`}
                style={{ background: c.hex }}
                title={c.name}
                onClick={() => setCustomDevice({ ...customDevice, color: c.hex })}
              />
            ))}
          </div>
          <div
            className={`custom-device-preview ${customDevice.name ? '' : 'disabled'}`}
            draggable={!!customDevice.name}
            onDragStart={(e) => {
              if (!customDevice.name) return;
              e.dataTransfer.setData('text/custom-device', JSON.stringify(customDevice));
            }}
          >
            <span className="custom-device-preview-swatch" style={{ background: customDevice.color }} />
            {customDevice.name ? (
              <em>{customDevice.name}</em>
            ) : (
              <span>Enter a name, then drag to place</span>
            )}
          </div>
        </div>
      </aside>

      <section className="rack-view">
        {selectedRack ? (
          <>
            <div className="rack-view-header">
              <h2>{selectedRack.name}</h2>
              <form className="rack-edit-form" onSubmit={handleSaveRack}>
                <input
                  value={rackEdits.name}
                  onChange={(e) => setRackEdits({ ...rackEdits, name: e.target.value })}
                  placeholder="Name"
                  required
                />
                <input
                  value={rackEdits.location}
                  onChange={(e) => setRackEdits({ ...rackEdits, location: e.target.value })}
                  placeholder="Location"
                />
                <input
                  type="number"
                  min="4"
                  max="52"
                  value={rackEdits.u_height}
                  onChange={(e) => setRackEdits({ ...rackEdits, u_height: Number(e.target.value) })}
                  placeholder="U Height"
                />
                <select
                  value={rackEdits.rack_type}
                  onChange={(e) => setRackEdits({ ...rackEdits, rack_type: e.target.value })}
                >
                  {RACK_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <button type="submit">Save</button>
                <button type="button" className="danger" onClick={handleDeleteRack}>
                  Delete Rack
                </button>
              </form>
              <div className="rack-export-actions">
                <button type="button" disabled={exporting} onClick={() => handleExport('png')}>
                  Export PNG
                </button>
                <button type="button" disabled={exporting} onClick={() => handleExport('pdf')}>
                  Export PDF
                </button>
              </div>
            </div>

            <div className="rack-side-toggle">
              <button
                type="button"
                className={selectedSide === 'front' ? 'active' : ''}
                onClick={() => setSelectedSide('front')}
              >
                Front
              </button>
              <button
                type="button"
                className={selectedSide === 'back' ? 'active' : ''}
                onClick={() => setSelectedSide('back')}
              >
                Back
              </button>
            </div>

            <div ref={rackFrameRef} className={`rack-frame rack-frame-${selectedRack.rack_type}`}>
              {uRows.map((u) => {
                const slot = slotsByTopPosition[u];
                if (slot) {
                  const isDevice = slot.item_type === 'device';
                  const isCustomDevice = slot.item_type === 'custom-device';
                  return (
                    <div
                      key={u}
                      className={`rack-unit occupied ${isCustomDevice ? 'custom-device' : ''}`}
                      style={{
                        height: `${slot.u_size * 28}px`,
                        ...(isCustomDevice && slot.color ? { borderColor: slot.color } : {}),
                      }}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData('text/slot-id', String(slot.id))}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => handleDrop(u, e)}
                    >
                      <span className="rack-unit-label">U{slot.u_position}</span>
                      <div className="rack-unit-device">
                        {isDevice ? (
                          <button
                            className="rack-unit-device-name"
                            onClick={() =>
                              setPortEditorDevice({
                                id: slot.device_id,
                                hostname: slot.hostname,
                                ip: slot.ip,
                              })
                            }
                          >
                            {slot.hostname || slot.ip || `Device ${slot.device_id}`}
                          </button>
                        ) : isCustomDevice ? (
                          <input
                            className="rack-unit-item-label rack-unit-custom-name"
                            defaultValue={slot.item_label || ''}
                            onBlur={(e) => handleItemLabelChange(slot, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') e.target.blur();
                            }}
                          />
                        ) : (
                          <input
                            className="rack-unit-item-label"
                            defaultValue={slot.item_label || ITEM_TYPE_LABELS[slot.item_type] || ''}
                            onBlur={(e) => handleItemLabelChange(slot, e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') e.target.blur();
                            }}
                          />
                        )}
                        {isCustomDevice && (
                          <>
                            <select
                              className="rack-unit-custom-type"
                              value={slot.custom_type || ''}
                              onChange={(e) => handleCustomTypeChange(slot, e.target.value)}
                            >
                              {CUSTOM_DEVICE_TYPES.map((t) => (
                                <option key={t} value={t}>
                                  {t}
                                </option>
                              ))}
                            </select>
                            <div className="custom-device-swatches">
                              {COLOR_SWATCHES.map((c) => (
                                <button
                                  key={c.hex}
                                  type="button"
                                  className={`custom-device-swatch ${slot.color === c.hex ? 'active' : ''}`}
                                  style={{ background: c.hex }}
                                  title={c.name}
                                  onClick={() => handleCustomColorChange(slot, c.hex)}
                                />
                              ))}
                            </div>
                          </>
                        )}
                        <label className="rack-unit-size">
                          U Size
                          <input
                            type="number"
                            min="1"
                            value={slot.u_size}
                            onChange={(e) => handleResizeSlot(slot, Number(e.target.value))}
                          />
                        </label>
                        <label className="rack-unit-side">
                          Side
                          <select
                            value={slot.side}
                            onChange={(e) => handleSlotSideChange(slot, e.target.value)}
                          >
                            {SIDE_OPTIONS.map((opt) => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button className="rack-unit-remove" onClick={() => handleRemoveSlot(slot.id)}>
                          &times;
                        </button>
                      </div>
                    </div>
                  );
                }

                if (coveredPositions.has(u)) {
                  return null;
                }

                return (
                  <div
                    key={u}
                    className="rack-unit"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => handleDrop(u, e)}
                  >
                    <span className="rack-unit-label">U{u}</span>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="page-status">Select or create a rack to begin.</div>
        )}
      </section>

      {portEditorDevice && (
        <PortEditorModal
          device={portEditorDevice}
          devices={devices}
          onClose={() => setPortEditorDevice(null)}
        />
      )}
    </div>
  );
}
