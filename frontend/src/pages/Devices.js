import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Network } from 'lucide-react';
import client from '../api/client';
import { platformInfo } from '../components/integrations/platforms';
import './Devices.css';

const emptyDevice = {
  hostname: '',
  ip: '',
  mac: '',
  type: '',
  snmp_community: '',
  notes: '',
  make: '',
  model: '',
  serial_number: '',
  purchase_date: '',
  warranty_expiry: '',
};
const emptyPort = { port_name: '', port_number: '', cable_type: '', speed: '' };

export default function DevicesPage() {
  const { id } = useParams();
  const [devices, setDevices] = useState([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState(id ? Number(id) : null);
  const [ports, setPorts] = useState([]);
  const [newDevice, setNewDevice] = useState(emptyDevice);
  const [newPort, setNewPort] = useState(emptyPort);
  const [editDevice, setEditDevice] = useState(emptyDevice);
  const [savingDevice, setSavingDevice] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
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
    if (id) setSelectedDeviceId(Number(id));
  }, [id]);

  useEffect(() => {
    loadPorts(selectedDeviceId);
    const device = devices.find((d) => d.id === selectedDeviceId);
    setEditDevice(
      device
        ? {
            ...emptyDevice,
            ...device,
            purchase_date: device.purchase_date ? String(device.purchase_date).slice(0, 10) : '',
            warranty_expiry: device.warranty_expiry ? String(device.warranty_expiry).slice(0, 10) : '',
          }
        : emptyDevice
    );
    setSavedAt(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const handleSaveDevice = async (e) => {
    e.preventDefault();
    if (!selectedDeviceId) return;
    setSavingDevice(true);
    setSavedAt(null);
    try {
      const res = await client.put(`/devices/${selectedDeviceId}`, editDevice);
      setDevices((prev) => prev.map((d) => (d.id === selectedDeviceId ? res.data : d)));
      setSavedAt(Date.now());
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingDevice(false);
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
                <span className="device-name-row">
                  <strong>{device.hostname || device.ip || `Device ${device.id}`}</strong>
                  {device.topology_node_id != null && (
                    <Network size={14} className="device-topology-icon" title="Linked to a topology node" />
                  )}
                  {device.source_integration_id != null &&
                    (() => {
                      const { icon: SourceIcon, label } = platformInfo(device.source_integration_platform);
                      return (
                        <SourceIcon
                          size={14}
                          className="device-source-icon"
                          title={`Imported from ${label}${
                            device.source_integration_name ? ` (${device.source_integration_name})` : ''
                          }`}
                        />
                      );
                    })()}
                </span>
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
          <input
            placeholder="Make"
            value={newDevice.make}
            onChange={(e) => setNewDevice({ ...newDevice, make: e.target.value })}
          />
          <input
            placeholder="Model"
            value={newDevice.model}
            onChange={(e) => setNewDevice({ ...newDevice, model: e.target.value })}
          />
          <input
            placeholder="Serial Number"
            value={newDevice.serial_number}
            onChange={(e) => setNewDevice({ ...newDevice, serial_number: e.target.value })}
          />
          <label className="device-form-date-label">
            Purchase Date
            <input
              type="date"
              value={newDevice.purchase_date}
              onChange={(e) => setNewDevice({ ...newDevice, purchase_date: e.target.value })}
            />
          </label>
          <label className="device-form-date-label">
            Warranty Expiry
            <input
              type="date"
              value={newDevice.warranty_expiry}
              onChange={(e) => setNewDevice({ ...newDevice, warranty_expiry: e.target.value })}
            />
          </label>
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
            <div className="device-detail-header">
              <h2>{selectedDevice.hostname || selectedDevice.ip}</h2>
            </div>

            <form onSubmit={handleSaveDevice} className="device-edit-form">
              <label>
                Hostname
                <input
                  value={editDevice.hostname || ''}
                  onChange={(e) => setEditDevice({ ...editDevice, hostname: e.target.value })}
                />
              </label>
              <label>
                IP Address
                <input
                  value={editDevice.ip || ''}
                  onChange={(e) => setEditDevice({ ...editDevice, ip: e.target.value })}
                />
              </label>
              <label>
                MAC Address
                <input
                  value={editDevice.mac || ''}
                  onChange={(e) => setEditDevice({ ...editDevice, mac: e.target.value })}
                />
              </label>
              <label>
                Type
                <input
                  value={editDevice.type || ''}
                  onChange={(e) => setEditDevice({ ...editDevice, type: e.target.value })}
                />
              </label>
              <label>
                SNMP Community
                <input
                  value={editDevice.snmp_community || ''}
                  onChange={(e) => setEditDevice({ ...editDevice, snmp_community: e.target.value })}
                />
              </label>
              <label>
                Make
                <input
                  value={editDevice.make || ''}
                  onChange={(e) => setEditDevice({ ...editDevice, make: e.target.value })}
                />
              </label>
              <label>
                Model
                <input
                  value={editDevice.model || ''}
                  onChange={(e) => setEditDevice({ ...editDevice, model: e.target.value })}
                />
              </label>
              <label>
                Serial Number
                <input
                  value={editDevice.serial_number || ''}
                  onChange={(e) => setEditDevice({ ...editDevice, serial_number: e.target.value })}
                />
              </label>
              <label>
                Purchase Date
                <input
                  type="date"
                  value={editDevice.purchase_date || ''}
                  onChange={(e) => setEditDevice({ ...editDevice, purchase_date: e.target.value })}
                />
              </label>
              <label>
                Warranty Expiry
                <input
                  type="date"
                  value={editDevice.warranty_expiry || ''}
                  onChange={(e) => setEditDevice({ ...editDevice, warranty_expiry: e.target.value })}
                />
              </label>
              <label className="full-width">
                Notes
                <textarea
                  value={editDevice.notes || ''}
                  onChange={(e) => setEditDevice({ ...editDevice, notes: e.target.value })}
                />
              </label>
              <div className="device-edit-actions">
                <button type="submit" disabled={savingDevice}>
                  {savingDevice ? 'Saving...' : 'Save Changes'}
                </button>
                {savedAt && <span className="device-edit-saved">Saved.</span>}
              </div>
            </form>

            <h2>Ports</h2>
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
