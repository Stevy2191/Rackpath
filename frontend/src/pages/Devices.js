import React, { useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Columns3, Loader2, Network, Plus, Radio, Search, Tag, X } from 'lucide-react';
import client from '../api/client';
import { useProject } from '../project/ProjectContext';
import { platformInfo } from '../components/integrations/platforms';
import ManageTagsModal from '../components/devices/ManageTagsModal';
import ScanResultModal from '../components/devices/ScanResultModal';
import BulkActionToolbar from '../components/devices/BulkActionToolbar';
import BulkEditModal from '../components/devices/BulkEditModal';
import CameraFormModal from '../components/cameras/CameraFormModal';
import './Devices.css';

const emptyDevice = {
  hostname: '',
  ip: '',
  mac: '',
  type: '',
  snmp_community: '',
  notes: '',
  location: '',
  make: '',
  model: '',
  serial_number: '',
  purchase_date: '',
  warranty_expiry: '',
};
const emptyPort = { port_name: '', port_number: '', cable_type: '', speed: '' };

const TYPE_FILTER_OPTIONS = [
  { value: '', label: 'All Types' },
  { value: 'router', label: 'Router' },
  { value: 'switch', label: 'Switch' },
  { value: 'ap', label: 'AP' },
  { value: 'server', label: 'Server' },
  { value: 'firewall', label: 'Firewall' },
  { value: 'camera', label: 'Camera' },
  { value: 'access', label: 'Access' },
  { value: 'other', label: 'Other' },
];

const COLUMN_DEFS = [
  { key: 'ip', label: 'IP Address' },
  { key: 'mac', label: 'MAC Address' },
  { key: 'type', label: 'Type' },
  { key: 'location', label: 'Location' },
  { key: 'make', label: 'Make' },
  { key: 'model', label: 'Model' },
  { key: 'serial_number', label: 'Serial Number' },
  { key: 'tags', label: 'Tags' },
  { key: 'credential', label: 'Credential' },
  { key: 'last_seen', label: 'Last Seen' },
];

const DEFAULT_VISIBLE_COLUMNS = {
  ip: true,
  mac: true,
  type: true,
  location: true,
  make: false,
  model: true,
  serial_number: false,
  tags: true,
  credential: true,
  last_seen: true,
};

const PAGE_SIZE = 25;

function deviceStatusClass(status) {
  if (status === 'up' || status === 'online') return 'devices-status-online';
  if (status === 'down' || status === 'offline') return 'devices-status-offline';
  return 'devices-status-unknown';
}

// Composite key used for bulk-selection, since `devices` and `project_cameras`
// each have their own id sequence and a device and camera can share an id.
function rowKey(row) {
  return `${row.source || 'device'}:${row.id}`;
}

function formatLastSeen(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleString();
}

// Picks readable foreground text for a colored tag pill.
function pillTextColor(hex) {
  if (!hex || hex.length !== 7) return '#fff';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1a1a1a' : '#ffffff';
}

export default function DevicesPage() {
  const { id } = useParams();
  const location = useLocation();
  const { currentProjectId } = useProject();

  const isNetworkView = location.pathname === '/devices/network';
  const typeFilterOptions = isNetworkView
    ? TYPE_FILTER_OPTIONS.filter((opt) => opt.value !== 'camera' && opt.value !== 'access')
    : TYPE_FILTER_OPTIONS;

  const [devices, setDevices] = useState([]);
  const [accessDevices, setAccessDevices] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [tags, setTags] = useState([]);
  const [macros, setMacros] = useState([]);
  const [locations, setLocations] = useState([]);
  const [scanningId, setScanningId] = useState(null);
  const [scanResult, setScanResult] = useState(null); // { device, result }
  const [toast, setToast] = useState(null);

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [locationFilter, setLocationFilter] = useState('');
  const [tagFilterIds, setTagFilterIds] = useState([]);
  const [page, setPage] = useState(1);

  const [visibleColumns, setVisibleColumns] = useState(DEFAULT_VISIBLE_COLUMNS);
  const [showColumnsMenu, setShowColumnsMenu] = useState(false);
  const [showManageTags, setShowManageTags] = useState(false);
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [tagPickerDeviceId, setTagPickerDeviceId] = useState(null);
  const [openTagPopover, setOpenTagPopover] = useState(null);

  const [selectedIds, setSelectedIds] = useState(new Set());
  const [showBulkEdit, setShowBulkEdit] = useState(false);
  const [cameraModalState, setCameraModalState] = useState(null); // null | camera object

  const [selectedDeviceId, setSelectedDeviceId] = useState(id ? Number(id) : null);
  const [ports, setPorts] = useState([]);
  const [newDevice, setNewDevice] = useState(emptyDevice);
  const [newPort, setNewPort] = useState(emptyPort);
  const [editDevice, setEditDevice] = useState(emptyDevice);
  const [savingDevice, setSavingDevice] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError] = useState(null);

  const buildParams = () => {
    const params = {};
    if (search.trim()) params.search = search.trim();
    if (typeFilter) params.type = typeFilter;
    if (locationFilter) params.location = locationFilter;
    if (tagFilterIds.length) params.tag = tagFilterIds.join(',');
    return params;
  };

  const loadDevices = (params) => {
    client
      .get('/devices', { params })
      .then((res) => setDevices(res.data || []))
      .catch((err) => setError(err.response?.data?.error || err.message));
  };

  const loadTags = () => {
    if (!currentProjectId) return;
    client
      .get(`/projects/${currentProjectId}/device-tags`)
      .then((res) => setTags(res.data || []))
      .catch((err) => setError(err.response?.data?.error || err.message));
  };

  const showToast = (toastInfo) => {
    setToast(toastInfo);
    setTimeout(() => setToast(null), 6000);
  };

  const loadMacros = () => {
    if (!currentProjectId) return;
    client
      .get(`/projects/${currentProjectId}/macros`)
      .then((res) => setMacros(res.data || []))
      .catch((err) => setError(err.response?.data?.error || err.message));
  };

  const loadAccessDevices = () => {
    if (!currentProjectId) return;
    client
      .get(`/projects/${currentProjectId}/access-devices`)
      .then((res) => setAccessDevices(res.data || []))
      .catch(() => setAccessDevices([]));
  };

  // Loads full camera records (including stream URLs/password) so the camera
  // edit modal has everything it needs — the combined /devices response only
  // includes the columns shared with the devices table.
  const loadCameras = () => {
    if (!currentProjectId) return;
    client
      .get(`/projects/${currentProjectId}/cameras`)
      .then((res) => setCameras(res.data || []))
      .catch(() => setCameras([]));
  };

  const loadLocations = () => {
    client
      .get('/devices')
      .then((res) => {
        const set = new Set();
        (res.data || []).forEach((d) => {
          if (d.location) set.add(d.location);
        });
        setLocations(Array.from(set).sort());
      })
      .catch(() => {});
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
    loadLocations();
  }, []);

  useEffect(() => {
    loadTags();
    loadMacros();
    loadAccessDevices();
    loadCameras();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId]);

  useEffect(() => {
    const handle = setTimeout(() => {
      loadDevices(buildParams());
      setPage(1);
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, typeFilter, locationFilter, tagFilterIds]);

  useEffect(() => {
    if (id) setSelectedDeviceId(Number(id));
  }, [id]);

  useEffect(() => {
    loadPorts(selectedDeviceId);
    const device = devices.find((d) => d.id === selectedDeviceId && d.source !== 'camera');
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

  // Close any open per-row popovers/dropdowns when clicking elsewhere.
  useEffect(() => {
    const handleDocClick = () => {
      setTagPickerDeviceId(null);
      setOpenTagPopover(null);
      setShowColumnsMenu(false);
    };
    document.addEventListener('click', handleDocClick);
    return () => document.removeEventListener('click', handleDocClick);
  }, []);

  const handleCreateDevice = async (e) => {
    e.preventDefault();
    try {
      await client.post('/devices', newDevice);
      setNewDevice(emptyDevice);
      loadDevices(buildParams());
      loadLocations();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeleteDevice = async (deviceId) => {
    try {
      await client.delete(`/devices/${deviceId}`);
      if (selectedDeviceId === deviceId) setSelectedDeviceId(null);
      loadDevices(buildParams());
      loadLocations();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDeleteAccessDevice = async (accessId) => {
    try {
      await client.delete(`/access-devices/${accessId}`);
      setAccessDevices((prev) => prev.filter((a) => a.id !== accessId));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleSaveDevice = async (e) => {
    e.preventDefault();
    if (!selectedDeviceId) return;
    setSavingDevice(true);
    setSavedAt(null);
    try {
      const res = await client.put(`/devices/${selectedDeviceId}`, editDevice);
      setDevices((prev) => prev.map((d) => (d.id === selectedDeviceId ? { ...d, ...res.data } : d)));
      setSavedAt(Date.now());
      loadLocations();
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

  const handleLocationCommit = async (device, value) => {
    const next = value.trim() || null;
    if (next === (device.location || null)) return;
    try {
      const res = await client.patch(`/devices/${device.id}`, { location: next });
      setDevices((prev) => prev.map((d) => (d.id === device.id ? { ...d, location: res.data.location } : d)));
      loadLocations();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleAssignTag = async (device, tagId) => {
    const source = device.source || 'device';
    console.log('[Devices] assigning tag', tagId, 'to', source, device.id);
    const url = source === 'camera' ? `/cameras/${device.id}/tags` : `/devices/${device.id}/tags`;
    try {
      const res = await client.post(url, { tag_id: tagId });
      console.log('[Devices] assign tag response:', res.data);
      setDevices((prev) =>
        prev.map((d) => (d.id === device.id && (d.source || 'device') === source ? { ...d, tags: res.data } : d))
      );
    } catch (err) {
      console.error('[Devices] assign tag failed:', err);
      setError(err.response?.data?.error || err.message);
    } finally {
      setTagPickerDeviceId(null);
    }
  };

  const handleRemoveTag = async (device, tagId) => {
    const source = device.source || 'device';
    console.log('[Devices] removing tag', tagId, 'from', source, device.id);
    const url = source === 'camera' ? `/cameras/${device.id}/tags/${tagId}` : `/devices/${device.id}/tags/${tagId}`;
    try {
      await client.delete(url);
      console.log('[Devices] remove tag succeeded for', source, device.id);
      setDevices((prev) =>
        prev.map((d) =>
          d.id === device.id && (d.source || 'device') === source
            ? { ...d, tags: (d.tags || []).filter((t) => t.id !== tagId) }
            : d
        )
      );
    } catch (err) {
      console.error('[Devices] remove tag failed:', err);
      setError(err.response?.data?.error || err.message);
    } finally {
      setOpenTagPopover(null);
    }
  };

  const handleCredentialChange = async (device, macroId) => {
    try {
      const res = await client.patch(`/devices/${device.id}`, { credential_macro_id: macroId || null });
      setDevices((prev) =>
        prev.map((d) => (d.id === device.id ? { ...d, credential_macro_id: res.data.credential_macro_id } : d))
      );
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const toggleSelect = (key) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSelectAll = (rows) => {
    const keys = rows.map(rowKey);
    const allSelected = keys.length > 0 && keys.every((k) => selectedIds.has(k));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        keys.forEach((k) => next.delete(k));
      } else {
        keys.forEach((k) => next.add(k));
      }
      return next;
    });
  };

  const selectedItems = () =>
    Array.from(selectedIds).map((key) => {
      const [source, idStr] = key.split(':');
      return { id: Number(idStr), source };
    });

  const handleBulkDelete = async () => {
    const items = selectedItems();
    if (items.length === 0) return;
    if (!window.confirm(`Delete ${items.length} selected device${items.length === 1 ? '' : 's'}?`)) return;
    try {
      await client.post('/devices/bulk-delete', { items });
      setSelectedIds(new Set());
      if (items.some((i) => i.source === 'device' && i.id === selectedDeviceId)) setSelectedDeviceId(null);
      loadDevices(buildParams());
      loadLocations();
      loadCameras();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleBulkEditSave = async (fields) => {
    const items = selectedItems();
    console.log('[Devices] bulk-update request:', { items, ...fields });
    const res = await client.post('/devices/bulk-update', { items, ...fields });
    console.log('[Devices] bulk-update response:', res.data);
    setSelectedIds(new Set());
    setShowBulkEdit(false);
    loadDevices(buildParams());
    loadLocations();
    loadCameras();
  };

  const handleCameraRowClick = (device) => {
    const camera = cameras.find((c) => c.id === device.id);
    setCameraModalState(camera || null);
  };

  const handleSaveCamera = async (draft) => {
    const res = await client.put(`/cameras/${cameraModalState.id}`, draft);
    setCameras((prev) => prev.map((c) => (c.id === cameraModalState.id ? res.data : c)));
    setCameraModalState(null);
    loadDevices(buildParams());
    loadLocations();
  };

  const handleDeleteCamera = async (cameraId) => {
    try {
      await client.delete(`/cameras/${cameraId}`);
      setCameras((prev) => prev.filter((c) => c.id !== cameraId));
      loadDevices(buildParams());
      loadLocations();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const macroById = React.useMemo(() => new Map(macros.map((m) => [m.id, m])), [macros]);

  const canScan = (device) => {
    if (!device.ip || !device.credential_macro_id) return false;
    const macro = macroById.get(device.credential_macro_id);
    return !!macro && macro.type.startsWith('snmp');
  };

  const handleScan = async (device) => {
    setScanningId(device.id);
    setError('');
    try {
      const res = await client.post(`/devices/${device.id}/scan`, {});
      setDevices((prev) =>
        prev.map((d) => (d.id === device.id ? { ...d, last_scanned_at: new Date().toISOString() } : d))
      );
      setScanResult({ device, result: res.data });
      if (res.data.topologyInterfaceCount > 0) {
        window.dispatchEvent(new CustomEvent('device-scan-complete', { detail: { deviceId: device.id } }));
        const count = res.data.topologyInterfaceCount;
        showToast({
          type: 'success',
          text: `Topology updated — ${count} interface${count === 1 ? '' : 's'} synced to ${res.data.topologyNodeHostname}`,
        });
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setScanningId(null);
    }
  };

  const handleUpdateDeviceFromScan = async (device, result) => {
    const patch = {};
    if (result.sysName) patch.hostname = result.sysName;
    if (result.sysLocation) patch.location = result.sysLocation;
    if (Object.keys(patch).length === 0) {
      setScanResult(null);
      return;
    }
    try {
      const res = await client.patch(`/devices/${device.id}`, patch);
      setDevices((prev) => prev.map((d) => (d.id === device.id ? { ...d, ...res.data } : d)));
      loadLocations();
      setScanResult(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const toggleTagFilter = (tagId) => {
    setTagFilterIds((prev) => (prev.includes(tagId) ? prev.filter((tid) => tid !== tagId) : [...prev, tagId]));
  };

  const clearFilters = () => {
    setSearch('');
    setTypeFilter('');
    setLocationFilter('');
    setTagFilterIds([]);
  };

  const toggleColumn = (key) => {
    setVisibleColumns((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleTagsChanged = () => {
    loadTags();
    loadDevices(buildParams());
  };

  const filtersActive = !!(search || typeFilter || locationFilter || tagFilterIds.length);

  // Access devices live in a separate table, so they're fetched separately
  // and merged into the All Devices view as read-only rows with an "Access"
  // type badge — filters are applied client-side to match.
  const accessDeviceRows = isNetworkView
    ? []
    : accessDevices
        .filter((a) => {
          if (typeFilter && typeFilter !== 'access') return false;
          if (locationFilter && (a.location || '') !== locationFilter) return false;
          if (tagFilterIds.length > 0) return false;
          if (search.trim()) {
            const q = search.trim().toLowerCase();
            const haystack = [a.name, a.ip_address, a.mac, a.model, a.location];
            if (!haystack.some((v) => (v || '').toLowerCase().includes(q))) return false;
          }
          return true;
        })
        .map((a) => ({
          id: `access-${a.id}`,
          _access: true,
          _accessId: a.id,
          hostname: a.name,
          ip: a.ip_address,
          mac: a.mac,
          type: 'access',
          location: a.location,
          make: null,
          model: a.model,
          serial_number: null,
          status: a.last_seen ? (a.online ? 'up' : 'down') : null,
          last_scanned_at: a.last_seen,
          tags: [],
          credential_macro_id: null,
          topology_node_id: null,
          source_integration_id: null,
        }));

  const viewDevices = isNetworkView ? devices.filter((d) => d.type !== 'camera') : [...devices, ...accessDeviceRows];

  const totalCount = viewDevices.length;
  const pageCount = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageDevices = viewDevices.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const selectedDevice = devices.find((d) => d.id === selectedDeviceId && d.source !== 'camera');

  return (
    <div className="devices-page">
      <div className="devices-page-header">
        <h2>{isNetworkView ? 'Network Devices' : 'All Devices'}</h2>
      </div>

      {error && <div className="page-error">{error}</div>}

      <div className="devices-toolbar">
        <div className="devices-filters">
          <div className="devices-search">
            <Search size={14} />
            <input
              placeholder="Search hostname, IP, model, serial..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            {typeFilterOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <select value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)}>
            <option value="">All Locations</option>
            {locations.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>

          <div className="devices-tag-filters">
            {tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className={`device-tag-pill${tagFilterIds.includes(tag.id) ? ' active' : ''}`}
                style={{ background: tag.color, color: pillTextColor(tag.color) }}
                onClick={() => toggleTagFilter(tag.id)}
              >
                {tag.name}
              </button>
            ))}
          </div>

          {filtersActive && (
            <button type="button" className="devices-clear-filters" onClick={clearFilters}>
              Clear Filters
            </button>
          )}
        </div>

        <div className="devices-toolbar-actions">
          <button type="button" onClick={() => setShowAddDevice((v) => !v)}>
            <Plus size={14} /> Add Device
          </button>
          <button type="button" onClick={() => setShowManageTags(true)}>
            <Tag size={14} /> Manage Tags
          </button>
          <div className="devices-columns-menu">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowColumnsMenu((v) => !v);
              }}
            >
              <Columns3 size={14} /> Columns
            </button>
            {showColumnsMenu && (
              <div className="devices-columns-dropdown" onClick={(e) => e.stopPropagation()}>
                {COLUMN_DEFS.map((col) => (
                  <label key={col.key} className="devices-columns-option">
                    <input
                      type="checkbox"
                      checked={!!visibleColumns[col.key]}
                      onChange={() => toggleColumn(col.key)}
                    />
                    {col.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showAddDevice && (
        <form onSubmit={handleCreateDevice} className="device-form devices-add-form">
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
            placeholder="Location"
            value={newDevice.location}
            onChange={(e) => setNewDevice({ ...newDevice, location: e.target.value })}
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
      )}

      <div className="devices-count">
        Showing {pageDevices.length} of {totalCount} devices
      </div>

      <BulkActionToolbar
        count={selectedIds.size}
        onEdit={() => setShowBulkEdit(true)}
        onDelete={handleBulkDelete}
        onClear={() => setSelectedIds(new Set())}
      />

      <div className="devices-table-wrap">
        <table className="devices-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={pageDevices.some((d) => !d._access) && pageDevices.filter((d) => !d._access).every((d) => selectedIds.has(rowKey(d)))}
                  onChange={() => toggleSelectAll(pageDevices.filter((d) => !d._access))}
                />
              </th>
              <th>Status</th>
              <th>Hostname</th>
              {visibleColumns.ip && <th>IP Address</th>}
              {visibleColumns.mac && <th>MAC Address</th>}
              {visibleColumns.type && <th>Type</th>}
              {visibleColumns.location && <th>Location</th>}
              {visibleColumns.make && <th>Make</th>}
              {visibleColumns.model && <th>Model</th>}
              {visibleColumns.serial_number && <th>Serial Number</th>}
              {visibleColumns.tags && <th>Tags</th>}
              {visibleColumns.credential && <th>Credential</th>}
              {visibleColumns.last_seen && <th>Last Seen</th>}
              <th>Scan</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {pageDevices.map((device) => {
              const deviceTags = device.tags || [];
              const availableTags = tags.filter((t) => !deviceTags.some((dt) => dt.id === t.id));
              const isAccess = !!device._access;
              const isCamera = device.source === 'camera';
              return (
                <tr
                  key={rowKey(device)}
                  className={!isAccess && !isCamera && device.id === selectedDeviceId ? 'active' : ''}
                >
                  <td>
                    {!isAccess && (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(rowKey(device))}
                        onChange={() => toggleSelect(rowKey(device))}
                      />
                    )}
                  </td>
                  <td>
                    <span
                      className={`devices-status-dot ${deviceStatusClass(device.status)}`}
                      title={device.status || 'unknown'}
                    />
                  </td>
                  <td>
                    {isAccess ? (
                      <span className="device-name-row">
                        <strong>{device.hostname || `Access Device ${device._accessId}`}</strong>
                      </span>
                    ) : (
                      <button
                        className="device-name-link"
                        onClick={() => (isCamera ? handleCameraRowClick(device) : setSelectedDeviceId(device.id))}
                      >
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
                      </button>
                    )}
                  </td>
                  {visibleColumns.ip && <td>{device.ip || ''}</td>}
                  {visibleColumns.mac && <td>{device.mac || ''}</td>}
                  {visibleColumns.type && (
                    <td>{isAccess ? <span className="devices-type-badge">Access</span> : device.type || ''}</td>
                  )}
                  {visibleColumns.location && (
                    <td>
                      {isAccess || isCamera ? (
                        device.location || '—'
                      ) : (
                        <input
                          key={`loc-${device.id}-${device.location || ''}`}
                          className="devices-location-input"
                          defaultValue={device.location || ''}
                          placeholder="—"
                          onBlur={(e) => handleLocationCommit(device, e.target.value)}
                        />
                      )}
                    </td>
                  )}
                  {visibleColumns.make && <td>{device.make || ''}</td>}
                  {visibleColumns.model && <td>{device.model || ''}</td>}
                  {visibleColumns.serial_number && <td>{device.serial_number || ''}</td>}
                  {visibleColumns.tags && (
                    <td className="devices-tags-cell">
                      {isAccess ? (
                        <div className="device-tag-list">—</div>
                      ) : (
                      <div className="device-tag-list">
                        {deviceTags.map((tag) => (
                          <span key={tag.id} className="device-tag-pill-wrap">
                            <button
                              type="button"
                              className="device-tag-pill"
                              style={{ background: tag.color, color: pillTextColor(tag.color) }}
                              onClick={(e) => {
                                e.stopPropagation();
                                const key = `${rowKey(device)}-${tag.id}`;
                                setOpenTagPopover((prev) => (prev === key ? null : key));
                              }}
                            >
                              {tag.name}
                            </button>
                            {openTagPopover === `${rowKey(device)}-${tag.id}` && (
                              <div className="device-tag-popover" onClick={(e) => e.stopPropagation()}>
                                <button type="button" onClick={() => handleRemoveTag(device, tag.id)}>
                                  Remove tag
                                </button>
                              </div>
                            )}
                          </span>
                        ))}
                        <span className="device-tag-add-wrap">
                          <button
                            type="button"
                            className="device-tag-add-btn"
                            title="Add tag"
                            onClick={(e) => {
                              e.stopPropagation();
                              setTagPickerDeviceId((prev) => (prev === rowKey(device) ? null : rowKey(device)));
                            }}
                          >
                            <Plus size={12} />
                          </button>
                          {tagPickerDeviceId === rowKey(device) && (
                            <div className="device-tag-dropdown" onClick={(e) => e.stopPropagation()}>
                              {availableTags.length === 0 ? (
                                <div className="device-tag-dropdown-empty">No more tags</div>
                              ) : (
                                availableTags.map((t) => (
                                  <button
                                    key={t.id}
                                    type="button"
                                    className="device-tag-dropdown-item"
                                    onClick={() => handleAssignTag(device, t.id)}
                                  >
                                    <span className="device-tag-dropdown-swatch" style={{ background: t.color }} />
                                    {t.name}
                                  </button>
                                ))
                              )}
                            </div>
                          )}
                        </span>
                      </div>
                      )}
                    </td>
                  )}
                  {visibleColumns.credential && (
                    <td>
                      {isAccess || isCamera ? (
                        '—'
                      ) : (
                      <select
                        className="devices-credential-select"
                        value={device.credential_macro_id || ''}
                        onChange={(e) => handleCredentialChange(device, e.target.value ? Number(e.target.value) : null)}
                      >
                        <option value="">—</option>
                        {macros.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                      )}
                    </td>
                  )}
                  {visibleColumns.last_seen && <td>{formatLastSeen(device.last_scanned_at)}</td>}
                  <td>
                    {!isAccess && !isCamera && (
                      <button
                        type="button"
                        className="devices-scan-btn"
                        title={canScan(device) ? 'Run SNMP scan' : 'Requires an IP address and an SNMP credential macro'}
                        disabled={!canScan(device) || scanningId === device.id}
                        onClick={() => handleScan(device)}
                      >
                        {scanningId === device.id ? (
                          <Loader2 size={14} className="devices-spin" />
                        ) : (
                          <Radio size={14} />
                        )}
                      </button>
                    )}
                  </td>
                  <td>
                    <button
                      className="delete-btn"
                      onClick={() =>
                        isAccess
                          ? handleDeleteAccessDevice(device._accessId)
                          : isCamera
                          ? handleDeleteCamera(device.id)
                          : handleDeleteDevice(device.id)
                      }
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="devices-pagination">
        <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1}>
          <ChevronLeft size={16} />
        </button>
        <span>
          Page {currentPage} of {pageCount}
        </span>
        <button
          type="button"
          onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
          disabled={currentPage >= pageCount}
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {selectedDevice && (
        <section className="port-editor">
          <div className="device-detail-header">
            <h2>{selectedDevice.hostname || selectedDevice.ip}</h2>
            <button type="button" className="devices-close-detail" onClick={() => setSelectedDeviceId(null)}>
              <X size={16} />
            </button>
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
              Location
              <input
                value={editDevice.location || ''}
                onChange={(e) => setEditDevice({ ...editDevice, location: e.target.value })}
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
                        .filter((d) => d.source !== 'camera' && d.id !== selectedDeviceId)
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
        </section>
      )}

      {showManageTags && (
        <ManageTagsModal
          projectId={currentProjectId}
          tags={tags}
          onClose={() => setShowManageTags(false)}
          onChange={handleTagsChanged}
        />
      )}

      {scanResult && (
        <ScanResultModal
          device={scanResult.device}
          result={scanResult.result}
          onClose={() => setScanResult(null)}
          onUpdateDevice={handleUpdateDeviceFromScan}
        />
      )}

      {showBulkEdit && (
        <BulkEditModal
          count={selectedIds.size}
          tags={tags}
          macros={macros}
          onSave={handleBulkEditSave}
          onClose={() => setShowBulkEdit(false)}
        />
      )}

      {cameraModalState && (
        <CameraFormModal initial={cameraModalState} onSave={handleSaveCamera} onClose={() => setCameraModalState(null)} />
      )}

      {toast && <div className={`devices-toast devices-toast-${toast.type}`}>{toast.text}</div>}
    </div>
  );
}
