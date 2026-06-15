import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Cable, LayoutGrid, Plus } from 'lucide-react';
import client from '../api/client';
import PortEditorModal from '../components/PortEditorModal';
import RackCanvas from '../components/racks/RackCanvas';
import DeviceCatalog from '../components/racks/DeviceCatalog';
import AddRackModal from '../components/racks/AddRackModal';
import RackDeviceContextMenu from '../components/racks/RackDeviceContextMenu';
import './Racks.css';

function scrollRackIntoView(rackId) {
  requestAnimationFrame(() => {
    document.getElementById(`rack-${rackId}`)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  });
}

export default function RacksPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [racks, setRacks] = useState([]);
  const [devices, setDevices] = useState([]);
  const [allSlots, setAllSlots] = useState([]);
  const [rackCustomDevices, setRackCustomDevices] = useState([]);
  const [error, setError] = useState(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [focusedRackId, setFocusedRackId] = useState(null);
  const [highlightedSlotId, setHighlightedSlotId] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [portEditorDevice, setPortEditorDevice] = useState(null);
  const [addRackOpen, setAddRackOpen] = useState(false);
  const [cableViewEnabled, setCableViewEnabled] = useState(false);

  const loadRacks = useCallback(() => {
    client.get('/racks').then((res) => setRacks(res.data)).catch((err) => setError(err.message));
  }, []);

  const loadDevices = useCallback(() => {
    client.get('/devices').then((res) => setDevices(res.data)).catch((err) => setError(err.message));
  }, []);

  const loadAllSlots = useCallback(() => {
    client.get('/rack-slots').then((res) => setAllSlots(res.data)).catch((err) => setError(err.message));
  }, []);

  const loadCustomDevices = useCallback(() => {
    client
      .get('/rack-custom-devices')
      .then((res) => setRackCustomDevices(res.data))
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    loadRacks();
    loadDevices();
    loadAllSlots();
    loadCustomDevices();
  }, [loadRacks, loadDevices, loadAllSlots, loadCustomDevices]);

  // Cross-link from a Topology node's "Rack Location" button:
  // ?highlightDevice=<id> finds the slot for that device, focuses/highlights
  // it, scrolls its rack into view, and clears the param.
  useEffect(() => {
    const highlightDeviceId = searchParams.get('highlightDevice');
    if (!highlightDeviceId) return;
    if (allSlots.length === 0) return;

    const slot = allSlots.find((s) => String(s.device_id) === highlightDeviceId);
    if (slot) {
      setHighlightedSlotId(slot.id);
      setFocusedRackId(slot.rack_id);
      scrollRackIntoView(slot.rack_id);
      setTimeout(() => setHighlightedSlotId(null), 3000);
    }

    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('highlightDevice');
        return next;
      },
      { replace: true }
    );
  }, [allSlots, searchParams, setSearchParams]);

  const actions = {
    onSlotCreate: async (payload) => {
      try {
        await client.post('/rack-slots', payload);
        loadAllSlots();
      } catch (err) {
        setError(err.response?.data?.error || err.message);
      }
    },
    onSlotUpdate: async (slot, changes) => {
      const previous = allSlots;
      setAllSlots((cur) => cur.map((s) => (s.id === slot.id ? { ...s, ...changes } : s)));
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
          front_back: slot.front_back,
          catalog_id: slot.catalog_id,
          custom_image_url: slot.custom_image_url,
          vendor: slot.vendor,
          ...changes,
        });
      } catch (err) {
        setAllSlots(previous);
        setError(err.response?.data?.error || err.message);
      }
    },
    onSlotDelete: async (slotId) => {
      const previous = allSlots;
      setAllSlots((cur) => cur.filter((s) => s.id !== slotId));
      try {
        await client.delete(`/rack-slots/${slotId}`);
      } catch (err) {
        setAllSlots(previous);
        setError(err.response?.data?.error || err.message);
      }
    },
    onRackSave: async (rackId, edits) => {
      try {
        await client.put(`/racks/${rackId}`, edits);
        loadRacks();
      } catch (err) {
        setError(err.response?.data?.error || err.message);
      }
    },
    onRackDelete: async (rackId) => {
      try {
        await client.delete(`/racks/${rackId}`);
        setFocusedRackId((cur) => (cur === rackId ? null : cur));
        loadRacks();
        loadAllSlots();
      } catch (err) {
        setError(err.response?.data?.error || err.message);
      }
    },
    onOpenContextMenu: (slot, x, y) => setContextMenu({ slot, x, y }),
    onOpenPortEditor: (device) => setPortEditorDevice(device),
  };

  const handleAddRack = async (rack) => {
    const res = await client.post('/racks', rack);
    loadRacks();
    setFocusedRackId(res.data.id);
    scrollRackIntoView(res.data.id);
  };

  const handleCustomDeviceCreated = (custom) => {
    setRackCustomDevices((prev) => [...prev, custom]);
  };

  const handleCustomDeviceDeleted = async (id) => {
    try {
      await client.delete(`/rack-custom-devices/${id}`);
      setRackCustomDevices((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  return (
    <div className="racks-page">
      {error && (
        <div className="page-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <div className="racks-toolbar">
        <h2>Rack Builder</h2>
        <div className="racks-toolbar-actions">
          <button
            type="button"
            className={cableViewEnabled ? 'active' : ''}
            onClick={() => setCableViewEnabled((v) => !v)}
          >
            <Cable size={14} /> Show Cables
          </button>
          <button type="button" className={catalogOpen ? 'active' : ''} onClick={() => setCatalogOpen((v) => !v)}>
            <LayoutGrid size={14} /> Device Catalog
          </button>
          <button type="button" className="primary" onClick={() => setAddRackOpen(true)}>
            <Plus size={14} /> Add Rack
          </button>
        </div>
      </div>

      <div className="racks-main">
        <RackCanvas
          racks={racks}
          allSlots={allSlots}
          rackCustomDevices={rackCustomDevices}
          highlightedSlotId={highlightedSlotId}
          actions={actions}
          cableViewEnabled={cableViewEnabled}
          focusedRackId={focusedRackId}
          onFocusRack={(id) => setFocusedRackId((cur) => (cur === id ? null : id))}
          onAddRack={() => setAddRackOpen(true)}
        />
        {catalogOpen && (
          <DeviceCatalog
            open={catalogOpen}
            onClose={() => setCatalogOpen(false)}
            racks={racks}
            allSlots={allSlots}
            devices={devices}
            rackCustomDevices={rackCustomDevices}
            focusedRackId={focusedRackId}
            actions={actions}
            onCustomDeviceCreated={handleCustomDeviceCreated}
            onCustomDeviceDeleted={handleCustomDeviceDeleted}
          />
        )}
      </div>

      {contextMenu && (
        <RackDeviceContextMenu
          slot={contextMenu.slot}
          x={contextMenu.x}
          y={contextMenu.y}
          devices={devices}
          onClose={() => setContextMenu(null)}
          actions={actions}
        />
      )}

      {addRackOpen && <AddRackModal onClose={() => setAddRackOpen(false)} onCreate={handleAddRack} />}

      {portEditorDevice && (
        <PortEditorModal device={portEditorDevice} devices={devices} onClose={() => setPortEditorDevice(null)} />
      )}
    </div>
  );
}
