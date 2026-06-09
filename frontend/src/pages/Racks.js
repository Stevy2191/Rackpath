import React, { useEffect, useState } from 'react';
import client from '../api/client';
import './Racks.css';

const emptyRack = { name: '', location: '', u_height: 42, notes: '' };

export default function RacksPage() {
  const [racks, setRacks] = useState([]);
  const [devices, setDevices] = useState([]);
  const [selectedRackId, setSelectedRackId] = useState(null);
  const [selectedRack, setSelectedRack] = useState(null);
  const [newRack, setNewRack] = useState(emptyRack);
  const [error, setError] = useState(null);

  const loadRacks = () => {
    client.get('/racks').then((res) => setRacks(res.data)).catch((err) => setError(err.message));
  };

  const loadSelectedRack = (id) => {
    if (!id) {
      setSelectedRack(null);
      return;
    }
    client.get(`/racks/${id}`).then((res) => setSelectedRack(res.data)).catch((err) => setError(err.message));
  };

  useEffect(() => {
    loadRacks();
    client.get('/devices').then((res) => setDevices(res.data)).catch((err) => setError(err.message));
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
      loadSelectedRack(selectedRack.id);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRemoveSlot = async (slotId) => {
    try {
      await client.delete(`/rack-slots/${slotId}`);
      loadSelectedRack(selectedRack.id);
    } catch (err) {
      setError(err.message);
    }
  };

  const slotsByPosition = {};
  if (selectedRack) {
    for (const slot of selectedRack.slots) {
      slotsByPosition[slot.u_position] = slot;
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

        <h3>Devices</h3>
        <p className="hint">Drag a device onto a U slot to mount it.</p>
        <ul className="device-list">
          {devices.map((device) => (
            <li
              key={device.id}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/device-id', String(device.id))}
            >
              {device.hostname || device.ip || `Device ${device.id}`}
            </li>
          ))}
        </ul>
      </aside>

      <section className="rack-view">
        {selectedRack ? (
          <>
            <h2>{selectedRack.name}</h2>
            <div className="rack-frame">
              {uRows.map((u) => {
                const slot = slotsByPosition[u];
                return (
                  <div
                    key={u}
                    className={`rack-unit${slot ? ' occupied' : ''}`}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => handleDrop(u, e)}
                  >
                    <span className="rack-unit-label">U{u}</span>
                    {slot && (
                      <div className="rack-unit-device">
                        <span>{slot.hostname || slot.ip || `Device ${slot.device_id}`}</span>
                        <button onClick={() => handleRemoveSlot(slot.id)}>&times;</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="page-status">Select or create a rack to begin.</div>
        )}
      </section>
    </div>
  );
}
