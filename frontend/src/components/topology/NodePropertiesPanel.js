import React, { useEffect, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import client from '../../api/client';
import { useProject } from '../../project/ProjectContext';
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

const CONNECTION_POINT_POSITIONS = ['top', 'bottom', 'left', 'right'];

const IFACE_NAME_DISPLAY_MAX = 12;

// Long interface names (e.g. "GigabitEthernet0/0/1") are truncated with an
// ellipsis in the list so rows stay aligned; the full name is shown via the
// title tooltip and in the edit input.
function truncateIfaceName(name) {
  if (!name || name.length <= IFACE_NAME_DISPLAY_MAX) return name;
  return `${name.slice(0, IFACE_NAME_DISPLAY_MAX)}…`;
}

export default function NodePropertiesPanel({
  node,
  onClose,
  onUpdateDevice,
  onUpdateNode,
  onDelete,
  onCopy,
  onConnectionPointsChange,
}) {
  const { currentProjectId } = useProject();
  const [displayNode, setDisplayNode] = useState(null);
  const [hostname, setHostname] = useState('');
  const [interfaces, setInterfaces] = useState([]);
  const [connectionPoints, setConnectionPoints] = useState([]);
  const [editingNameId, setEditingNameId] = useState(null);
  const [error, setError] = useState(null);
  const [vlans, setVlans] = useState([]);

  useEffect(() => {
    client
      .get(`/projects/${currentProjectId || 1}/vlans`)
      .then((res) => setVlans(res.data || []))
      .catch(() => setVlans([]));
  }, [currentProjectId]);

  useEffect(() => {
    if (node) setDisplayNode(node);
  }, [node]);

  const data = displayNode?.data;
  const nodeId = data?.id;
  const linkedDeviceId = data?.deviceId;

  useEffect(() => {
    setHostname(data?.hostname || '');
    // Only re-sync local input state when the selected node changes, not
    // on every keystroke while editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  const loadInterfaces = (deviceId) => {
    client
      .get(`/topology/nodes/${deviceId}/interfaces`)
      .then((res) => setInterfaces(res.data || []))
      .catch(() => setInterfaces([]));
  };

  useEffect(() => {
    if (!linkedDeviceId) {
      setInterfaces([]);
      setConnectionPoints([]);
      return;
    }
    let cancelled = false;
    client
      .get(`/topology/nodes/${linkedDeviceId}/interfaces`)
      .then((res) => {
        if (!cancelled) setInterfaces(res.data || []);
      })
      .catch(() => {
        if (!cancelled) setInterfaces([]);
      });
    client
      .get(`/topology/nodes/${linkedDeviceId}/connection-points`)
      .then((res) => {
        if (!cancelled) setConnectionPoints(res.data || []);
      })
      .catch(() => {
        if (!cancelled) setConnectionPoints([]);
      });
    return () => {
      cancelled = true;
    };
  }, [linkedDeviceId]);

  // When a device is scanned (from the Device Inventory page), refresh this
  // panel's interface list in place if it's currently showing that device.
  useEffect(() => {
    if (!linkedDeviceId) return;
    const handler = (e) => {
      if (e.detail?.deviceId === linkedDeviceId) {
        loadInterfaces(linkedDeviceId);
      }
    };
    window.addEventListener('device-scan-complete', handler);
    return () => window.removeEventListener('device-scan-complete', handler);
  }, [linkedDeviceId]);

  if (!data) return <aside className="node-properties-panel" />;

  const info = DEVICE_TYPES[classifyDevice(data.type)];
  const Icon = info.icon;

  // Top-level interfaces, each with its VLAN sub-interfaces grouped beneath.
  const mainInterfaces = interfaces.filter((i) => !i.parent_id);
  const subInterfacesByParent = interfaces.reduce((acc, i) => {
    if (i.parent_id) (acc[i.parent_id] = acc[i.parent_id] || []).push(i);
    return acc;
  }, {});

  const commitHostname = () => {
    const next = hostname.trim() || null;
    if (next === (data.hostname || null)) return;
    if (linkedDeviceId) {
      onUpdateDevice(linkedDeviceId, { hostname: next });
    } else {
      onUpdateNode(nodeId, { label: next });
    }
  };

  const handleAddInterface = async () => {
    try {
      const res = await client.post(`/topology/nodes/${linkedDeviceId}/interfaces`, {
        name: `eth${mainInterfaces.length}`,
        description: '',
      });
      setInterfaces((prev) => [...prev, res.data]);
    } catch (err) {
      setError(err.message);
    }
  };

  const updateInterfaceField = (id, field, value) => {
    setInterfaces((prev) => prev.map((i) => (i.id === id ? { ...i, [field]: value } : i)));
  };

  const commitInterface = async (iface) => {
    try {
      await client.patch(`/topology/nodes/${linkedDeviceId}/interfaces/${iface.id}`, {
        name: iface.name || '',
        vlan_id: iface.vlan_id ?? null,
        ip: iface.ip || null,
      });
    } catch (err) {
      setError(err.message);
    }
  };

  const handleAddSubInterface = async (parent) => {
    try {
      const res = await client.post(`/topology/nodes/${linkedDeviceId}/interfaces`, {
        name: '',
        description: '',
        parent_id: parent.id,
        vlan_id: null,
      });
      setInterfaces((prev) => [...prev, res.data]);
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteInterface = async (id) => {
    try {
      await client.delete(`/topology/nodes/${linkedDeviceId}/interfaces/${id}`);
      // Drop the interface and any VLAN sub-interfaces parented to it.
      setInterfaces((prev) => prev.filter((i) => i.id !== id && i.parent_id !== id));
    } catch (err) {
      setError(err.message);
    }
  };

  const syncConnectionPoints = (points) => {
    setConnectionPoints(points);
    onConnectionPointsChange?.(linkedDeviceId, points);
  };

  const handleAddConnectionPoint = async () => {
    try {
      const res = await client.post(`/topology/nodes/${linkedDeviceId}/connection-points`, {
        name: `Port ${connectionPoints.length + 1}`,
        position: 'top',
      });
      syncConnectionPoints([...connectionPoints, res.data]);
    } catch (err) {
      setError(err.message);
    }
  };

  const updateConnectionPointField = (id, field, value) => {
    syncConnectionPoints(connectionPoints.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  };

  const commitConnectionPoint = async (point) => {
    try {
      await client.patch(`/topology/nodes/${linkedDeviceId}/connection-points/${point.id}`, {
        name: point.name || '',
        position: point.position,
      });
    } catch (err) {
      setError(err.message);
    }
  };

  const deleteConnectionPoint = async (id) => {
    try {
      await client.delete(`/topology/nodes/${linkedDeviceId}/connection-points/${id}`);
      syncConnectionPoints(connectionPoints.filter((p) => p.id !== id));
    } catch (err) {
      setError(err.message);
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
          {linkedDeviceId ? 'Hostname' : 'Label'}
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
          placeholder={linkedDeviceId ? `Device ${linkedDeviceId}` : `Node ${nodeId}`}
        />
      </div>

      <div className="node-properties-section">
        <span className="node-properties-label">Icon Color</span>
        <ColorSwatchPicker
          value={data.icon_color || null}
          onChange={(hex) =>
            linkedDeviceId ? onUpdateDevice(linkedDeviceId, { icon_color: hex }) : onUpdateNode(nodeId, { icon_color: hex })
          }
          onReset={() =>
            linkedDeviceId ? onUpdateDevice(linkedDeviceId, { icon_color: null }) : onUpdateNode(nodeId, { icon_color: null })
          }
        />
      </div>

      <div className="node-properties-section">
        <span className="node-properties-label">Text Color</span>
        <ColorSwatchPicker
          value={data.text_color || null}
          onChange={(hex) =>
            linkedDeviceId ? onUpdateDevice(linkedDeviceId, { text_color: hex }) : onUpdateNode(nodeId, { text_color: hex })
          }
          onReset={() =>
            linkedDeviceId ? onUpdateDevice(linkedDeviceId, { text_color: null }) : onUpdateNode(nodeId, { text_color: null })
          }
        />
      </div>

      {linkedDeviceId && (
      <div className="node-properties-section">
        <div className="node-properties-section-header">
          <span className="node-properties-section-title">Interfaces</span>
          <button type="button" className="node-properties-add-btn" onClick={handleAddInterface}>
            + Add
          </button>
        </div>
        <ul className="node-properties-iface-list">
          {mainInterfaces.map((iface) => (
            <React.Fragment key={iface.id}>
              <li className="node-properties-iface-row">
                {editingNameId === iface.id ? (
                  <input
                    autoFocus
                    className="node-properties-iface-name-input"
                    value={iface.name || ''}
                    onChange={(e) => updateInterfaceField(iface.id, 'name', e.target.value)}
                    onBlur={() => {
                      commitInterface(iface);
                      setEditingNameId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.target.blur();
                    }}
                    placeholder="eth0"
                  />
                ) : (
                  <span
                    className="node-properties-iface-name"
                    onClick={() => setEditingNameId(iface.id)}
                    title={iface.name || 'unnamed'}
                  >
                    {iface.name ? truncateIfaceName(iface.name) : 'unnamed'}
                  </span>
                )}
                {iface.status && (
                  <span className={`node-properties-iface-status node-properties-iface-status-${iface.status}`}>
                    {iface.status}
                  </span>
                )}
                <input
                  className="node-properties-iface-ip"
                  value={iface.ip || ''}
                  onChange={(e) => updateInterfaceField(iface.id, 'ip', e.target.value)}
                  onBlur={() => commitInterface(iface)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.target.blur();
                  }}
                  placeholder="IP Addr"
                />
                <button
                  type="button"
                  className="node-properties-iface-vlan-btn"
                  onClick={() => handleAddSubInterface(iface)}
                  title="Add VLAN sub-interface"
                >
                  VLAN
                </button>
                <button
                  type="button"
                  className="node-properties-iface-delete"
                  onClick={() => deleteInterface(iface.id)}
                  aria-label="Delete interface"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </li>
              {(subInterfacesByParent[iface.id] || []).map((sub) => (
                <li key={sub.id} className="node-properties-iface-row node-properties-iface-row-sub">
                  <span className="node-properties-vlan-prefix">— VLAN</span>
                  <input
                    type="number"
                    className="node-properties-vlan-id-input"
                    list="node-properties-vlan-options"
                    value={sub.vlan_id ?? ''}
                    onChange={(e) =>
                      updateInterfaceField(sub.id, 'vlan_id', e.target.value === '' ? null : Number(e.target.value))
                    }
                    onBlur={() => commitInterface(sub)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.target.blur();
                    }}
                    placeholder="ID"
                  />
                  <input
                    className="node-properties-iface-ip"
                    value={sub.ip || ''}
                    onChange={(e) => updateInterfaceField(sub.id, 'ip', e.target.value)}
                    onBlur={() => commitInterface(sub)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.target.blur();
                    }}
                    placeholder="IP Addr"
                  />
                  <button
                    type="button"
                    className="node-properties-iface-delete"
                    onClick={() => deleteInterface(sub.id)}
                    aria-label="Delete VLAN sub-interface"
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </React.Fragment>
          ))}
        </ul>
      </div>
      )}

      {linkedDeviceId && (
      <div className="node-properties-section">
        <span className="node-properties-label">Connection Points</span>
        <ul className="node-properties-interfaces">
          {connectionPoints.map((point) => (
            <li key={point.id} className="node-properties-interface-row">
              <div className="node-properties-interface-edit">
                <input
                  className="node-properties-input"
                  value={point.name || ''}
                  onChange={(e) => updateConnectionPointField(point.id, 'name', e.target.value)}
                  onBlur={() => commitConnectionPoint(point)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.target.blur();
                  }}
                  placeholder="Name (e.g. Uplink)"
                />
                <select
                  className="node-properties-input"
                  value={point.position}
                  onChange={(e) => {
                    const next = { ...point, position: e.target.value };
                    updateConnectionPointField(point.id, 'position', e.target.value);
                    commitConnectionPoint(next);
                  }}
                >
                  {CONNECTION_POINT_POSITIONS.map((pos) => (
                    <option key={pos} value={pos}>
                      {pos.charAt(0).toUpperCase() + pos.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="node-properties-icon-btn node-properties-icon-btn-danger"
                onClick={() => deleteConnectionPoint(point.id)}
                aria-label="Delete connection point"
                title="Delete"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="node-properties-add-interface" onClick={handleAddConnectionPoint}>
          + Add Connection Point
        </button>
        {error && <div className="node-properties-error">{error}</div>}
      </div>
      )}

      <div className="node-properties-section node-properties-actions">
        <span className="node-properties-label">Actions</span>
        <button type="button" className="node-properties-action-btn" onClick={onCopy}>
          Copy
        </button>
        <button type="button" className="node-properties-action-btn node-properties-delete" onClick={onDelete}>
          Delete
        </button>
      </div>

      <datalist id="node-properties-vlan-options">
        {vlans.map((v) => (
          <option key={v.id} value={v.vlan_id} label={`${v.name} (VLAN ${v.vlan_id})`} />
        ))}
      </datalist>
    </aside>
  );
}
