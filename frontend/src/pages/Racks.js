import React, { useEffect, useState } from 'react';
import client from '../api/client';
import PortEditorModal from '../components/PortEditorModal';
import './Racks.css';

const emptyRack = { name: '', location: '', u_height: 42, notes: '' };

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
      setError(err.message);
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
      setError(err.message);
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
      setError(err.message);
    }
  };

  const handleDrop = async (uPosition, e) => {
    e.preventDefault();
    const deviceId = e.dataTransfer.getData('text/device-id');
    if (!deviceId || !selectedRack) return;

    try {
      await client.post('/rack-slots', {
        rack_id: selectedRack.id,
        device_id: Number(deviceId),
        u_position: uPosition,
        u_size: 1,
      });
      refreshRackData(selectedRack.id);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRemoveSlot = async (slotId) => {
    try {
      await client.delete(`/rack-slots/${slotId}`);
      refreshRackData(selectedRack.id);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleResizeSlot = async (slot, uSize) => {
    if (uSize < 1) return;
    try {
      await client.put(`/rack-slots/${slot.id}`, {
        rack_id: slot.rack_id,
        device_id: slot.device_id,
        u_position: slot.u_position,
        u_size: uSize,
      });
      refreshRackData(selectedRack.id);
    } catch (err) {
      setError(err.message);
    }
  };

  const rackedDeviceIds = new Set(allSlots.map((slot) => slot.device_id).filter(Boolean));
  const unrackedDevices = devices.filter((d) => !rackedDeviceIds.has(d.id));

  // Map each U position covered by a slot to that slot, and track the
  // "top" position (u_position + u_size - 1) where the device block starts.
  const slotsByTopPosition = {};
  const coveredPositions = new Set();
  if (selectedRack) {
    for (const slot of selectedRack.slots) {
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
            min="1"
            placeholder="U Height"
            value={newRack.u_height}
            onChange={(e) => setNewRack({ ...newRack, u_height: Number(e.target.value) })}
          />
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
                  min="1"
                  value={rackEdits.u_height}
                  onChange={(e) => setRackEdits({ ...rackEdits, u_height: Number(e.target.value) })}
                  placeholder="U Height"
                />
                <button type="submit">Save</button>
                <button type="button" className="danger" onClick={handleDeleteRack}>
                  Delete Rack
                </button>
              </form>
            </div>

            <div className="rack-frame">
              {uRows.map((u) => {
                const slot = slotsByTopPosition[u];
                if (slot) {
                  return (
                    <div
                      key={u}
                      className="rack-unit occupied"
                      style={{ height: `${slot.u_size * 28}px` }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => handleDrop(u, e)}
                    >
                      <span className="rack-unit-label">U{slot.u_position}</span>
                      <div className="rack-unit-device">
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
                        <label className="rack-unit-size">
                          U Size
                          <input
                            type="number"
                            min="1"
                            value={slot.u_size}
                            onChange={(e) => handleResizeSlot(slot, Number(e.target.value))}
                          />
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
