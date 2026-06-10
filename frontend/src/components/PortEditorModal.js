import React, { useCallback, useEffect, useState } from 'react';
import client from '../api/client';
import './PortEditorModal.css';

const CABLE_TYPES = ['Cat5e', 'Cat6', 'Cat6a', 'Fiber', 'DAC', 'Other'];
const emptyPort = { port_name: '', port_number: '', cable_type: '', speed: '' };

export default function PortEditorModal({ device, devices, onClose }) {
  const [ports, setPorts] = useState([]);
  const [portsByDevice, setPortsByDevice] = useState({});
  const [newPort, setNewPort] = useState(emptyPort);
  const [error, setError] = useState(null);

  const loadPorts = useCallback(() => {
    client
      .get('/ports', { params: { device_id: device.id } })
      .then((res) => setPorts(res.data))
      .catch((err) => setError(err.message));
  }, [device.id]);

  useEffect(() => {
    loadPorts();
  }, [loadPorts]);

  const ensurePortsLoaded = useCallback(
    (deviceId) => {
      if (!deviceId || portsByDevice[deviceId]) return;
      client
        .get('/ports', { params: { device_id: deviceId } })
        .then((res) => setPortsByDevice((prev) => ({ ...prev, [deviceId]: res.data })))
        .catch((err) => setError(err.message));
    },
    [portsByDevice]
  );

  useEffect(() => {
    ports.forEach((port) => {
      if (port.connected_device_id) ensurePortsLoaded(port.connected_device_id);
    });
  }, [ports, ensurePortsLoaded]);

  const updatePortField = (port, field, value) => {
    const updated = { ...port, [field]: value };
    if (field === 'connected_device_id') {
      updated.connected_port_id = null;
      ensurePortsLoaded(value);
    }
    setPorts((prev) => prev.map((p) => (p.id === port.id ? updated : p)));
    return updated;
  };

  const savePort = async (port) => {
    try {
      await client.put(`/ports/${port.id}`, port);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeletePort = async (portId) => {
    try {
      await client.delete(`/ports/${portId}`);
      setPorts((prev) => prev.filter((p) => p.id !== portId));
    } catch (err) {
      setError(err.message);
    }
  };

  const handleAddPort = async (e) => {
    e.preventDefault();
    try {
      await client.post('/ports', { ...newPort, device_id: device.id });
      setNewPort(emptyPort);
      loadPorts();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>
          &times;
        </button>
        <h2>{device.hostname || device.ip || `Device ${device.id}`} &mdash; Ports</h2>
        {error && <div className="page-error">{error}</div>}

        <table className="port-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Number</th>
              <th>Cable Type</th>
              <th>Connected Device</th>
              <th>Connected Port</th>
              <th>Speed</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {ports.map((port) => (
              <tr key={port.id}>
                <td>
                  <input
                    value={port.port_name || ''}
                    onChange={(e) => updatePortField(port, 'port_name', e.target.value)}
                    onBlur={() => savePort(port)}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    value={port.port_number ?? ''}
                    onChange={(e) => updatePortField(port, 'port_number', Number(e.target.value))}
                    onBlur={() => savePort(port)}
                  />
                </td>
                <td>
                  <select
                    value={port.cable_type || ''}
                    onChange={(e) => savePort(updatePortField(port, 'cable_type', e.target.value))}
                  >
                    <option value="">-</option>
                    {CABLE_TYPES.map((ct) => (
                      <option key={ct} value={ct}>
                        {ct}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={port.connected_device_id ?? ''}
                    onChange={(e) => {
                      const value = e.target.value ? Number(e.target.value) : null;
                      savePort(updatePortField(port, 'connected_device_id', value));
                    }}
                  >
                    <option value="">-</option>
                    {devices
                      .filter((d) => d.id !== device.id)
                      .map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.hostname || d.ip || `Device ${d.id}`}
                        </option>
                      ))}
                  </select>
                </td>
                <td>
                  <select
                    value={port.connected_port_id ?? ''}
                    disabled={!port.connected_device_id}
                    onChange={(e) => {
                      const value = e.target.value ? Number(e.target.value) : null;
                      savePort(updatePortField(port, 'connected_port_id', value));
                    }}
                  >
                    <option value="">-</option>
                    {(portsByDevice[port.connected_device_id] || [])
                      .filter((p) => p.id !== port.id)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.port_name || `Port ${p.id}`}
                        </option>
                      ))}
                  </select>
                </td>
                <td>
                  <input
                    value={port.speed || ''}
                    onChange={(e) => updatePortField(port, 'speed', e.target.value)}
                    onBlur={() => savePort(port)}
                  />
                </td>
                <td>
                  <button onClick={() => handleDeletePort(port.id)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <form onSubmit={handleAddPort} className="port-form">
          <h3>Add Port</h3>
          <input
            placeholder="Name"
            value={newPort.port_name}
            onChange={(e) => setNewPort({ ...newPort, port_name: e.target.value })}
          />
          <input
            type="number"
            placeholder="Number"
            value={newPort.port_number}
            onChange={(e) => setNewPort({ ...newPort, port_number: e.target.value })}
          />
          <select
            value={newPort.cable_type}
            onChange={(e) => setNewPort({ ...newPort, cable_type: e.target.value })}
          >
            <option value="">Cable Type</option>
            {CABLE_TYPES.map((ct) => (
              <option key={ct} value={ct}>
                {ct}
              </option>
            ))}
          </select>
          <input
            placeholder="Speed"
            value={newPort.speed}
            onChange={(e) => setNewPort({ ...newPort, speed: e.target.value })}
          />
          <button type="submit">Add Port</button>
        </form>
      </div>
    </div>
  );
}
