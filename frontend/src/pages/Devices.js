import React, { useEffect, useState } from 'react';
import client from '../api/client';
import './Devices.css';

const emptyDevice = { hostname: '', ip: '', mac: '', type: '', snmp_community: '', notes: '' };
const emptyPort = { port_name: '', port_number: '', cable_type: '', speed: '' };

export default function DevicesPage() {
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(null);
  const [ports, setPorts] = useState([]);
  const [newDevice, setNewDevice] = useState(emptyDevice);
  const [newPort, setNewPort] = useState(emptyPort);
  const [error, setError] = useState(null);

  const loadDevices = () => {
    client.get('/devices').then((res) => setDevices(res.data)).catch((err) => setError(err.message));
  };

  const loadPorts = (deviceId) => {
    if (!deviceId) {
      setPorts([]);
      return;
    }
    client
      .get('/ports', { params: { device_id: deviceId } })
      .then((res) => setPorts(res.data))
      .catch((err) => setError(err.message));
  };

  useEffect(() => {
    loadDevices();
  }, []);

  useEffect(() => {
    loadPorts(selectedDeviceId);
  }, [selectedDeviceId]);

  const handleCreateDevice = async (e) => {
    e.preventDefault();
    try {
      await client.post('/devices', newDevice);
      setNewDevice(emptyDevice);
      loadDevices();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeleteDevice = async (id) => {
    try {
      await client.delete(`/devices/${id}`);
      if (selectedDeviceId === id) setSelectedDeviceId(null);
      loadDevices();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleCreatePort = async (e) => {
    e.preventDefault();
    if (!selectedDeviceId) return;
    try {
      await client.post('/ports', { ...newPort, device_id: selectedDeviceId });
      setNewPort(emptyPort);
      loadPorts(selectedDeviceId);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleUpdatePort = (port, field, value) => {
    const updated = { ...port, [field]: value };
    setPorts((prev) => prev.map((p) => (p.id === port.id ? updated : p)));
  };

  const handleSavePort = async (port) => {
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

  const selectedDevice = devices.find((d) => d.id === selectedDeviceId);

  return (
    <div className="devices-page">
      {error && <div className="page-error">{error}</div>}

      <aside className="devices-sidebar">
        <h2>Devices</h2>
        <ul className="device-list">
          {devices.map((device) => (
            <li key={device.id} className={device.id === selectedDeviceId ? 'active' : ''}>
              <button className="device-select" onClick={() => setSelectedDeviceId(device.id)}>
                <strong>{device.hostname || device.ip || `Device ${device.id}`}</strong>
                {device.type && <span className="device-type">{device.type}</span>}
              </button>
              <button className="delete-btn" onClick={() => handleDeleteDevice(device.id)}>
                Delete
              </button>
            </li>
          ))}
        </ul>

        <form onSubmit={handleCreateDevice} className="device-form">
          <h3>New Device</h3>
          <input
            placeholder="Hostname"
            value={newDevice.hostname}
            onChange={(e) => setNewDevice({ ...newDevice, hostname: e.target.value })}
          />
          <input
            placeholder="IP Address"
            value={newDevice.ip}
            onChange={(e) => setNewDevice({ ...newDevice, ip: e.target.value })}
          />
          <input
            placeholder="MAC Address"
            value={newDevice.mac}
            onChange={(e) => setNewDevice({ ...newDevice, mac: e.target.value })}
          />
          <input
            placeholder="Type"
            value={newDevice.type}
            onChange={(e) => setNewDevice({ ...newDevice, type: e.target.value })}
          />
          <input
            placeholder="SNMP Community"
            value={newDevice.snmp_community}
            onChange={(e) => setNewDevice({ ...newDevice, snmp_community: e.target.value })}
          />
          <textarea
            placeholder="Notes"
            value={newDevice.notes}
            onChange={(e) => setNewDevice({ ...newDevice, notes: e.target.value })}
          />
          <button type="submit">Add Device</button>
        </form>
      </aside>

      <section className="port-editor">
        {selectedDevice ? (
          <>
            <h2>{selectedDevice.hostname || selectedDevice.ip} &mdash; Ports</h2>
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
                        onChange={(e) => handleUpdatePort(port, 'port_name', e.target.value)}
                        onBlur={() => handleSavePort(port)}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={port.port_number ?? ''}
                        onChange={(e) => handleUpdatePort(port, 'port_number', Number(e.target.value))}
                        onBlur={() => handleSavePort(port)}
                      />
                    </td>
                    <td>
                      <input
                        value={port.cable_type || ''}
                        onChange={(e) => handleUpdatePort(port, 'cable_type', e.target.value)}
                        onBlur={() => handleSavePort(port)}
                      />
                    </td>
                    <td>
                      <select
                        value={port.connected_device_id ?? ''}
                        onChange={(e) => {
                          const value = e.target.value ? Number(e.target.value) : null;
                          const updated = { ...port, connected_device_id: value };
                          setPorts((prev) => prev.map((p) => (p.id === port.id ? updated : p)));
                          handleSavePort(updated);
                        }}
                      >
                        <option value="">-</option>
                        {devices
                          .filter((d) => d.id !== selectedDeviceId)
                          .map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.hostname || d.ip || `Device ${d.id}`}
                            </option>
                          ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        value={port.connected_port_id ?? ''}
                        onChange={(e) =>
                          handleUpdatePort(port, 'connected_port_id', e.target.value ? Number(e.target.value) : null)
                        }
                        onBlur={() => handleSavePort(port)}
                      />
                    </td>
                    <td>
                      <input
                        value={port.speed || ''}
                        onChange={(e) => handleUpdatePort(port, 'speed', e.target.value)}
                        onBlur={() => handleSavePort(port)}
                      />
                    </td>
                    <td>
                      <button onClick={() => handleDeletePort(port.id)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <form onSubmit={handleCreatePort} className="port-form">
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
              <input
                placeholder="Cable Type"
                value={newPort.cable_type}
                onChange={(e) => setNewPort({ ...newPort, cable_type: e.target.value })}
              />
              <input
                placeholder="Speed"
                value={newPort.speed}
                onChange={(e) => setNewPort({ ...newPort, speed: e.target.value })}
              />
              <button type="submit">Add Port</button>
            </form>
          </>
        ) : (
          <div className="page-status">Select a device to edit its ports.</div>
        )}
      </section>
    </div>
  );
}
