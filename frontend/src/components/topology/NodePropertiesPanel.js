import React, { useEffect, useState } from 'react';
import { Pencil, Trash2, X } from 'lucide-react';
import client from '../../api/client';
import {
  COLOR_SWATCHES,
  DEVICE_TYPES,
  classifyDevice,
  isCustomType,
  customIconFilename,
  customIconUrl,
} from './deviceTypes';
import './NodePropertiesPanel.css';

function ColorSwatchPicker({ value, onChange, onReset }) {
  return (
    <div className="node-properties-swatch-row">
      <div className="node-properties-swatches">
        {COLOR_SWATCHES.map((c) => (
          <button
            key={c.name}
            type="button"
            aria-label={c.name}
            title={c.name}
            className={`node-properties-swatch${value === c.hex ? ' selected' : ''}`}
            style={{ background: c.hex }}
            onClick={() => onChange(c.hex)}
          />
        ))}
      </div>
      <button type="button" className="node-properties-reset" onClick={onReset}>
        Reset to Default
      </button>
    </div>
  );
}

export default function NodePropertiesPanel({ node, onClose, onUpdateDevice, onDelete, onCopy }) {
  const [displayNode, setDisplayNode] = useState(null);
  const [hostname, setHostname] = useState('');
  const [ip, setIp] = useState('');
  const [interfaces, setInterfaces] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');

  useEffect(() => {
    if (node) setDisplayNode(node);
  }, [node]);

  const data = displayNode?.data;
  const deviceId = data?.id;

  useEffect(() => {
    setHostname(data?.hostname || '');
    setIp(data?.ip || '');
    setEditingId(null);
    // Only re-sync local input state when the selected device changes, not
    // on every keystroke while editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;
    client
      .get(`/topology/nodes/${deviceId}/interfaces`)
      .then((res) => {
        if (!cancelled) setInterfaces(res.data || []);
      })
      .catch(() => {
        if (!cancelled) setInterfaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId]);

  if (!data) return <aside className="node-properties-panel" />;

  const info = DEVICE_TYPES[classifyDevice(data.type)];
  const Icon = info.icon;

  const commitHostname = () => {
    const next = hostname.trim() || null;
    if (next !== (data.hostname || null)) onUpdateDevice(deviceId, { hostname: next });
  };

  const commitIp = () => {
    const next = ip.trim() || null;
    if (next !== (data.ip || null)) onUpdateDevice(deviceId, { ip: next });
  };

  const handleAddInterface = async () => {
    try {
      const res = await client.post(`/topology/nodes/${deviceId}/interfaces`, {
        name: 'New Interface',
        description: '',
      });
      setInterfaces((prev) => [...prev, res.data]);
      setEditingId(res.data.id);
      setEditName(res.data.name);
      setEditDescription(res.data.description || '');
    } catch {
      // ignore - interface list simply won't update
    }
  };

  const startEditInterface = (iface) => {
    setEditingId(iface.id);
    setEditName(iface.name);
    setEditDescription(iface.description || '');
  };

  const saveInterface = async () => {
    try {
      const res = await client.patch(`/topology/interfaces/${editingId}`, {
        name: editName.trim() || 'Interface',
        description: editDescription.trim() || null,
      });
      setInterfaces((prev) => prev.map((i) => (i.id === editingId ? res.data : i)));
    } catch {
      // ignore - edit will simply not be reflected
    } finally {
      setEditingId(null);
    }
  };

  const deleteInterface = async (id) => {
    try {
      await client.delete(`/topology/interfaces/${id}`);
      setInterfaces((prev) => prev.filter((i) => i.id !== id));
    } catch {
      // ignore - interface stays in the list
    }
  };

  return (
    <aside className={`node-properties-panel${node ? ' open' : ''}`}>
      <div className="node-properties-header">
        <span className="node-properties-icon" style={{ color: data.icon_color || info.color }}>
          {isCustomType(data.type) ? (
            <img className="node-properties-custom-icon" src={customIconUrl(customIconFilename(data.type))} alt="" />
          ) : (
            <Icon size={22} strokeWidth={2} />
          )}
        </span>
        <span className="node-properties-type">{info.label}</span>
        <button className="node-properties-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <div className="node-properties-section">
        <label className="node-properties-label" htmlFor="node-prop-hostname">
          Hostname
        </label>
        <input
          id="node-prop-hostname"
          className="node-properties-input"
          value={hostname}
          onChange={(e) => setHostname(e.target.value)}
          onBlur={commitHostname}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.target.blur();
          }}
          placeholder={`Device ${deviceId}`}
        />
      </div>

      <div className="node-properties-section">
        <label className="node-properties-label" htmlFor="node-prop-ip">
          IP Address
        </label>
        <input
          id="node-prop-ip"
          className="node-properties-input"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
          onBlur={commitIp}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.target.blur();
          }}
          placeholder="-"
        />
      </div>

      <div className="node-properties-section">
        <span className="node-properties-label">Icon Color</span>
        <ColorSwatchPicker
          value={data.icon_color || null}
          onChange={(hex) => onUpdateDevice(deviceId, { icon_color: hex })}
          onReset={() => onUpdateDevice(deviceId, { icon_color: null })}
        />
      </div>

      <div className="node-properties-section">
        <span className="node-properties-label">Text Color</span>
        <ColorSwatchPicker
          value={data.text_color || null}
          onChange={(hex) => onUpdateDevice(deviceId, { text_color: hex })}
          onReset={() => onUpdateDevice(deviceId, { text_color: null })}
        />
      </div>

      <div className="node-properties-section">
        <span className="node-properties-label">Interfaces</span>
        <ul className="node-properties-interfaces">
          {interfaces.map((iface) => (
            <li key={iface.id} className="node-properties-interface-row">
              {editingId === iface.id ? (
                <>
                  <div className="node-properties-interface-edit">
                    <input
                      className="node-properties-input"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Name"
                      autoFocus
                    />
                    <input
                      className="node-properties-input"
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      placeholder="Description / IP"
                    />
                  </div>
                  <div className="node-properties-interface-actions">
                    <button type="button" className="node-properties-icon-btn" onClick={saveInterface} title="Save">
                      Save
                    </button>
                    <button
                      type="button"
                      className="node-properties-icon-btn"
                      onClick={() => setEditingId(null)}
                      title="Cancel"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="node-properties-interface-info">
                    <div className="node-properties-interface-name">{iface.name}</div>
                    {iface.description && (
                      <div className="node-properties-interface-desc">{iface.description}</div>
                    )}
                  </div>
                  <div className="node-properties-interface-actions">
                    <button
                      type="button"
                      className="node-properties-icon-btn"
                      onClick={() => startEditInterface(iface)}
                      aria-label="Edit interface"
                      title="Edit"
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className="node-properties-icon-btn node-properties-icon-btn-danger"
                      onClick={() => deleteInterface(iface.id)}
                      aria-label="Delete interface"
                      title="Delete"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
        <button type="button" className="node-properties-add-interface" onClick={handleAddInterface}>
          + Add
        </button>
      </div>

      <div className="node-properties-section node-properties-actions">
        <span className="node-properties-label">Actions</span>
        <button type="button" className="node-properties-action-btn" onClick={onCopy}>
          Copy
        </button>
        <button type="button" className="node-properties-action-btn node-properties-delete" onClick={onDelete}>
          Delete
        </button>
      </div>
    </aside>
  );
}
