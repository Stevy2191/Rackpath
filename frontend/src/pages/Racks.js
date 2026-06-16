import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Cable, Download, FileDown, LayoutGrid, Plus } from 'lucide-react';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';
import client from '../api/client';
import PortEditorModal from '../components/PortEditorModal';
import RackCanvas from '../components/racks/RackCanvas';
import DeviceCatalog from '../components/racks/DeviceCatalog';
import DevicePropertiesPanel from '../components/racks/DevicePropertiesPanel';
import RackEditPanel from '../components/racks/RackEditPanel';
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
  const [rackEditOpen, setRackEditOpen] = useState(false);
  const [exportingRack, setExportingRack] = useState(false);
  const [highlightedSlotId, setHighlightedSlotId] = useState(null);
  const [selectedSlotId, setSelectedSlotId] = useState(null);
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
    client.get('/rack-custom-devices').then((res) => setRackCustomDevices(res.data)).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    loadRacks();
    loadDevices();
    loadAllSlots();
    loadCustomDevices();
  }, [loadRacks, loadDevices, loadAllSlots, loadCustomDevices]);

  // Cross-link from Topology: ?highlightDevice=<id>
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
      (prev) => { const n = new URLSearchParams(prev); n.delete('highlightDevice'); return n; },
      { replace: true }
    );
  }, [allSlots, searchParams, setSearchParams]);

  // Close properties panels with Escape
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        setSelectedSlotId(null);
        setRackEditOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Close rack edit panel when rack is deselected
  useEffect(() => {
    if (focusedRackId === null) setRackEditOpen(false);
  }, [focusedRackId]);

  const selectedSlot = selectedSlotId ? allSlots.find((s) => s.id === selectedSlotId) || null : null;
  const selectedSlotRack = selectedSlot ? racks.find((r) => r.id === selectedSlot.rack_id) || null : null;
  const focusedRack = focusedRackId ? racks.find((r) => r.id === focusedRackId) || null : null;

  const actions = {
    onSlotCreate: async (payload) => {
      try {
        const res = await client.post('/rack-slots', payload);
        setAllSlots((cur) => [...cur, res.data]);
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
          mounted_face: slot.mounted_face || slot.front_back || 'front',
          catalog_id: slot.catalog_id,
          custom_image_url: slot.custom_image_url,
          vendor: slot.vendor,
          ip_address: slot.ip_address,
          slot_notes: slot.slot_notes,
          ...changes,
        });
      } catch (err) {
        setAllSlots(previous);
        setError(err.response?.data?.error || err.message);
      }
    },
    onSlotDelete: async (slotId) => {
      if (selectedSlotId === slotId) setSelectedSlotId(null);
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
        setRackEditOpen(false);
        setSelectedSlotId(null);
        loadRacks();
        loadAllSlots();
      } catch (err) {
        setError(err.response?.data?.error || err.message);
      }
    },
    onRackDuplicate: async (rackId) => {
      const rack = racks.find((r) => r.id === rackId);
      if (!rack) return;
      const rackSlots = allSlots.filter((s) => s.rack_id === rackId);
      try {
        const res = await client.post('/racks', {
          name: `${rack.name} (copy)`,
          location: rack.location,
          u_height: rack.u_height,
          rack_type: rack.rack_type,
          notes: rack.notes,
        });
        const newRackId = res.data.id;
        for (const slot of rackSlots) {
          // eslint-disable-next-line no-await-in-loop
          await client.post('/rack-slots', {
            rack_id: newRackId,
            device_id: slot.device_id || null,
            item_type: slot.item_type,
            item_label: slot.item_label,
            vendor: slot.vendor,
            catalog_id: slot.catalog_id,
            custom_type: slot.custom_type,
            custom_image_url: slot.custom_image_url,
            u_position: slot.u_position,
            u_size: slot.u_size,
            mounted_face: slot.mounted_face || slot.front_back || 'front',
            half_depth: slot.half_depth,
            half_width: slot.half_width,
            color: slot.color,
            ip_address: slot.ip_address,
            slot_notes: slot.slot_notes,
          });
        }
        loadRacks();
        loadAllSlots();
        setFocusedRackId(newRackId);
        scrollRackIntoView(newRackId);
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

  const handleSlotUpdatedFromPanel = (updatedSlot) => {
    setAllSlots((cur) => cur.map((s) => (s.id === updatedSlot.id ? updatedSlot : s)));
  };

  const handleSelectSlot = (slotId) => {
    setSelectedSlotId((cur) => (cur === slotId ? null : slotId));
  };

  const handleExportRack = async (format) => {
    if (!focusedRackId) return;
    const rack = racks.find((r) => r.id === focusedRackId);
    if (!rack) return;
    const frame = document.querySelector(`#rack-${focusedRackId} .rack-dual-frame`);
    if (!frame) return;
    setExportingRack(true);
    try {
      const dataUrl = await toPng(frame, { backgroundColor: '#0a0a0f', width: frame.offsetWidth, height: frame.offsetHeight });
      const filename = rack.name.trim().replace(/\s+/g, '-').toLowerCase() || 'rack';
      if (format === 'pdf') {
        const pdf = new jsPDF({ orientation: frame.offsetWidth >= frame.offsetHeight ? 'landscape' : 'portrait', unit: 'px', format: [frame.offsetWidth, frame.offsetHeight] });
        pdf.addImage(dataUrl, 'PNG', 0, 0, frame.offsetWidth, frame.offsetHeight);
        pdf.save(`rack-${filename}.pdf`);
      } else {
        const a = document.createElement('a');
        a.download = `rack-${filename}.png`;
        a.href = dataUrl;
        a.click();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Rack export failed', err);
    } finally {
      setExportingRack(false);
    }
  };

  const rightPanel = selectedSlot ? (
    <DevicePropertiesPanel
      slot={selectedSlot}
      rackHeight={selectedSlotRack?.u_height || 42}
      rackSlots={allSlots.filter((s) => s.rack_id === selectedSlot.rack_id)}
      onClose={() => setSelectedSlotId(null)}
      onUpdated={handleSlotUpdatedFromPanel}
    />
  ) : (focusedRack && rackEditOpen) ? (
    <RackEditPanel
      rack={focusedRack}
      onClose={() => setRackEditOpen(false)}
      onSave={(edits) => actions.onRackSave(focusedRackId, edits)}
      onDuplicate={() => actions.onRackDuplicate(focusedRackId)}
      onDelete={() => actions.onRackDelete(focusedRackId)}
    />
  ) : null;

  return (
    <div className="racks-page">
      {error && (
        <div className="page-error" onClick={() => setError(null)}>{error}</div>
      )}

      <div className="racks-toolbar">
        <h2>Rack Builder</h2>
        <div className="racks-toolbar-actions">
          <button
            type="button"
            disabled={!focusedRackId || exportingRack}
            onClick={() => handleExportRack('png')}
            title="Export focused rack as PNG"
          >
            <Download size={14} />
          </button>
          <button
            type="button"
            disabled={!focusedRackId || exportingRack}
            onClick={() => handleExportRack('pdf')}
            title="Export focused rack as PDF"
          >
            <FileDown size={14} />
          </button>
          <button type="button" className={cableViewEnabled ? 'active' : ''} onClick={() => setCableViewEnabled((v) => !v)}>
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
            onCustomDeviceCreated={(custom) => setRackCustomDevices((prev) => [...prev, custom])}
            onCustomDeviceDeleted={async (id) => {
              try {
                await client.delete(`/rack-custom-devices/${id}`);
                setRackCustomDevices((prev) => prev.filter((c) => c.id !== id));
              } catch (err) {
                setError(err.response?.data?.error || err.message);
              }
            }}
          />
        )}

        <RackCanvas
          racks={racks}
          allSlots={allSlots}
          rackCustomDevices={rackCustomDevices}
          highlightedSlotId={highlightedSlotId}
          selectedSlotId={selectedSlotId}
          actions={actions}
          cableViewEnabled={cableViewEnabled}
          focusedRackId={focusedRackId}
          onFocusRack={setFocusedRackId}
          onSelectSlot={handleSelectSlot}
          onEditRack={() => setRackEditOpen((v) => !v)}
          rackEditOpen={rackEditOpen}
        />

        {rightPanel}
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
