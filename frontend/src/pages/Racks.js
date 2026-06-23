import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, LayoutGrid, Plus, Zap } from 'lucide-react';
import client from '../api/client';
import { useProject } from '../project/ProjectContext';
import PortEditorModal from '../components/PortEditorModal';
import RackCanvas from '../components/racks/RackCanvas';
import DeviceCatalog from '../components/racks/DeviceCatalog';
import QuickConfigModal from '../components/racks/QuickConfigModal';
import { SIMPLE_ITEM_TYPES } from '../components/racks/rackCatalog';
import DevicePropertiesPanel from '../components/racks/DevicePropertiesPanel';
import RackEditPanel from '../components/racks/RackEditPanel';
import { countUsedU } from '../components/racks/rackPlacement';
import AddRackModal from '../components/racks/AddRackModal';
import RackDeviceContextMenu from '../components/racks/RackDeviceContextMenu';
import RackContextMenu from '../components/racks/RackContextMenu';
import ExportModal from '../components/racks/ExportModal';
import UPSPowerSummary from '../components/racks/UPSPowerSummary';
import ConfirmModal from '../components/racks/ConfirmModal';
import { getDeviceLabel } from '../components/racks/DeviceBlock';
import './Racks.css';

function scrollRackIntoView(rackId) {
  requestAnimationFrame(() => {
    document.getElementById(`rack-${rackId}`)?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  });
}

export default function RacksPage() {
  const { currentProjectId } = useProject();
  const [searchParams, setSearchParams] = useSearchParams();
  const [racks, setRacks] = useState([]);
  const [locations, setLocations] = useState([]);
  const [devices, setDevices] = useState([]);
  const [allSlots, setAllSlots] = useState([]);
  const [userCatalogEntries, setUserCatalogEntries] = useState([]);
  const [pendingPlacement, setPendingPlacement] = useState(null); // { source, entry, target }
  const [error, setError] = useState(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [focusedRackId, setFocusedRackId] = useState(null);
  const [rackEditOpen, setRackEditOpen] = useState(false);
  const [highlightedSlotId, setHighlightedSlotId] = useState(null);
  const [selectedSlotId, setSelectedSlotId] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);         // device context menu
  const [rackContextMenu, setRackContextMenu] = useState(null); // { rackId, x, y }
  const [exportModal, setExportModal] = useState(null);         // { targetRacks: [] }
  const [renamingRackId, setRenamingRackId] = useState(null);
  const [fitRackRequest, setFitRackRequest] = useState(null);   // { id, t }
  const [portEditorDevice, setPortEditorDevice] = useState(null);
  const [addRackOpen, setAddRackOpen] = useState(false);
  const [deleteConfirmSlot, setDeleteConfirmSlot] = useState(null);
  const [deleteConfirmRack, setDeleteConfirmRack] = useState(null);
  const [upsSummaryOpen, setUpsSummaryOpen] = useState(false);
  const racksMainRef = useRef(null);

  const loadRacks = useCallback(() => {
    client.get('/racks').then((res) => setRacks(res.data)).catch((err) => setError(err.message));
  }, []);

  const loadDevices = useCallback(() => {
    client.get('/devices').then((res) => setDevices(res.data)).catch((err) => setError(err.message));
  }, []);

  const loadAllSlots = useCallback(() => {
    client.get('/rack-slots').then((res) => setAllSlots(res.data)).catch((err) => setError(err.message));
  }, []);

  const loadUserCatalogEntries = useCallback(() => {
    client.get('/user-catalog-entries').then((res) => setUserCatalogEntries(res.data)).catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    loadRacks();
    loadDevices();
    loadAllSlots();
    loadUserCatalogEntries();
  }, [loadRacks, loadDevices, loadAllSlots, loadUserCatalogEntries]);

  useEffect(() => {
    if (!currentProjectId) return;
    client.get(`/projects/${currentProjectId}/locations`)
      .then((res) => setLocations(res.data || []))
      .catch(() => setLocations([]));
  }, [currentProjectId]);

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

  // Escape closes panels/menus
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      setSelectedSlotId(null);
      setRackEditOpen(false);
      setRackContextMenu(null);
      setExportModal(null);
      setUpsSummaryOpen(false);
      setRenamingRackId(null);
      setDeleteConfirmSlot(null);
      setDeleteConfirmRack(null);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Delete/Backspace: device takes priority over rack when both are active
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (deleteConfirmSlot || deleteConfirmRack) return;
      if (selectedSlotId) {
        const slot = allSlots.find((s) => s.id === selectedSlotId);
        if (slot) setDeleteConfirmSlot(slot);
      } else if (focusedRackId) {
        const rack = racks.find((r) => r.id === focusedRackId);
        if (rack) setDeleteConfirmRack(rack);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [selectedSlotId, allSlots, deleteConfirmSlot, deleteConfirmRack, focusedRackId, racks]);

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
          half_depth: slot.half_depth,
          half_width: slot.half_width,
          half_position: slot.half_position,
          catalog_id: slot.catalog_id,
          custom_image_url: slot.custom_image_url,
          vendor: slot.vendor,
          ip_address: slot.ip_address,
          slot_notes: slot.slot_notes,
          outlet_groups: slot.outlet_groups,
          input_voltage: slot.input_voltage,
          input_plug_type: slot.input_plug_type,
          capacity_value: slot.capacity_value,
          capacity_unit: slot.capacity_unit,
          capacity_va: slot.capacity_va,
          capacity_w: slot.capacity_w,
          device_type: slot.device_type,
          ups_va_rating: slot.ups_va_rating,
          ups_watt_rating: slot.ups_watt_rating,
          ups_runtime_full: slot.ups_runtime_full,
          ups_runtime_half: slot.ups_runtime_half,
          ups_max_ebm_slots: slot.ups_max_ebm_slots,
          ebm_connected_ups_id: slot.ebm_connected_ups_id,
          ebm_runtime_full: slot.ebm_runtime_full,
          ebm_runtime_half: slot.ebm_runtime_half,
          port_count: slot.port_count,
          bay_count: slot.bay_count,
          power_source_slot_id: slot.power_source_slot_id,
          power_source_outlet: slot.power_source_outlet,
          mount_side: slot.mount_side,
          psu2_source_slot_id: slot.psu2_source_slot_id,
          psu2_source_outlet: slot.psu2_source_outlet,
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
    onSlotDuplicate: async (slot) => {
      const rack = racks.find((r) => r.id === slot.rack_id);
      if (!rack) return;
      const face = slot.mounted_face || slot.front_back || 'front';
      const occupied = new Set();
      for (const s of allSlots) {
        if (s.rack_id !== slot.rack_id) continue;
        // Vertical PDUs are 0U floating elements, not real U-grid
        // occupants — their stored u_position/u_size must never block
        // where a duplicated device can land.
        if (s.item_type === 'vertical-pdu') continue;
        const sFace = s.mounted_face || s.front_back || 'front';
        if (sFace !== 'both' && face !== 'both' && sFace !== face) continue;
        for (let u = s.u_position; u <= s.u_position + s.u_size - 1; u++) occupied.add(u);
      }
      let u_position = null;
      for (let start = 1; start + slot.u_size - 1 <= rack.u_height; start++) {
        let free = true;
        for (let u = start; u <= start + slot.u_size - 1; u++) {
          if (occupied.has(u)) { free = false; break; }
        }
        if (free) { u_position = start; break; }
      }
      if (u_position == null) {
        setError('No free space in this rack to duplicate this device');
        return;
      }
      try {
        const res = await client.post('/rack-slots', {
          rack_id: slot.rack_id,
          // Don't carry over the inventory-device link — two slots
          // shouldn't point at the same physical device.
          item_type: slot.item_type === 'device' ? 'custom-device' : slot.item_type,
          item_label: slot.item_label ? `${slot.item_label} (copy)` : null,
          custom_type: slot.custom_type,
          catalog_id: slot.catalog_id,
          u_position,
          u_size: slot.u_size,
          mounted_face: face,
          half_depth: slot.half_depth,
          half_width: slot.half_width,
          color: slot.color,
          outlet_groups: slot.outlet_groups,
          input_voltage: slot.input_voltage,
          input_plug_type: slot.input_plug_type,
          capacity_va: slot.capacity_va,
          capacity_w: slot.capacity_w,
          device_type: slot.device_type,
          ups_va_rating: slot.ups_va_rating,
          ups_watt_rating: slot.ups_watt_rating,
          ups_runtime_full: slot.ups_runtime_full,
          ups_runtime_half: slot.ups_runtime_half,
          ups_max_ebm_slots: slot.ups_max_ebm_slots,
          // ebm_connected_ups_id intentionally omitted — it references a slot
          // ID in the original rack that won't exist in the duplicated context.
          ebm_runtime_full: slot.ebm_runtime_full,
          ebm_runtime_half: slot.ebm_runtime_half,
          capacity_value: slot.capacity_value,
          capacity_unit: slot.capacity_unit,
          port_count: slot.port_count,
          bay_count: slot.bay_count,
        });
        setAllSlots((cur) => [...cur, res.data]);
        setSelectedSlotId(res.data.id);
      } catch (err) {
        setError(err.response?.data?.error || err.message);
      }
    },
    onRackSave: async (rackId, edits) => {
      try {
        await client.put(`/racks/${rackId}`, edits);
        loadRacks();
        // A height change may have reflowed device positions server-side —
        // refetch so the canvas reflects their new U positions.
        loadAllSlots();
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
            outlet_groups: slot.outlet_groups,
            input_voltage: slot.input_voltage,
            input_plug_type: slot.input_plug_type,
            capacity_va: slot.capacity_va,
            capacity_w: slot.capacity_w,
            device_type: slot.device_type,
            ups_va_rating: slot.ups_va_rating,
            ups_watt_rating: slot.ups_watt_rating,
            ups_runtime_full: slot.ups_runtime_full,
            ups_runtime_half: slot.ups_runtime_half,
            ups_max_ebm_slots: slot.ups_max_ebm_slots,
            // ebm_connected_ups_id intentionally omitted — references original rack slot IDs.
            ebm_runtime_full: slot.ebm_runtime_full,
            ebm_runtime_half: slot.ebm_runtime_half,
            capacity_value: slot.capacity_value,
            capacity_unit: slot.capacity_unit,
            port_count: slot.port_count,
            bay_count: slot.bay_count,
            mount_side: slot.mount_side,
            // power_source_slot_id/outlet intentionally not copied — they'd
            // point at slot ids from the original rack, not the duplicate.
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

  // ─── Generic catalog placement (quick-config step) ──────────────────────────
  const requestPlacement = (pending) => setPendingPlacement(pending);
  const cancelPlacement = () => setPendingPlacement(null);

  const inferDeviceType = (renderType, label) => {
    if (renderType === 'ups' || /\bups\b/i.test(label || '')) return 'ups';
    if (renderType === 'ebm' || /\bebm\b|battery module|extended battery/i.test(label || '')) return 'ebm';
    return null;
  };

  const confirmPlacement = (fields) => {
    if (!pendingPlacement) return;
    const { source, entry, target } = pendingPlacement;
    const renderType = fields.render_type;
    const itemType = SIMPLE_ITEM_TYPES.includes(renderType) ? renderType : 'custom-device';
    actions.onSlotCreate({
      rack_id: target.rack_id,
      item_type: itemType,
      item_label: fields.label,
      catalog_id: source === 'catalog' ? entry.id : null,
      custom_type: renderType,
      u_position: target.u_position,
      u_size: fields.u_size,
      mounted_face: target.mounted_face,
      color: fields.color,
      half_depth: fields.half_depth ? 1 : 0,
      half_width: fields.half_width ? 1 : 0,
      outlet_groups: fields.outlet_groups || [],
      input_voltage: fields.input_voltage || null,
      input_plug_type: fields.input_plug_type || null,
      capacity_va: fields.capacity_va || null,
      capacity_w: fields.capacity_w || null,
      device_type: fields.device_type ?? inferDeviceType(renderType, fields.label),
      capacity_value: fields.capacity_value || null,
      capacity_unit: fields.capacity_unit || null,
      port_count: fields.port_count || null,
      bay_count: fields.bay_count || null,
    });
    setPendingPlacement(null);
  };

  // ─── User catalog entries ("Save to Catalog" / Custom tab) ──────────────────
  const saveSlotToCatalog = async (slot, name) => {
    try {
      const res = await client.post('/user-catalog-entries', {
        name,
        render_type: slot.custom_type || slot.item_type,
        u_size: slot.u_size,
        color: slot.color,
        half_width: slot.half_width,
        half_depth: slot.half_depth,
        mounted_face: slot.mounted_face || slot.front_back || 'front',
        outlet_groups: slot.outlet_groups,
        input_voltage: slot.input_voltage,
        input_plug_type: slot.input_plug_type,
        capacity_va: slot.capacity_va,
        capacity_w: slot.capacity_w,
        capacity_value: slot.capacity_value,
        capacity_unit: slot.capacity_unit,
        port_count: slot.port_count,
        bay_count: slot.bay_count,
      });
      setUserCatalogEntries((cur) => [...cur, res.data]);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const renameCustomEntry = async (id, name) => {
    try {
      const res = await client.put(`/user-catalog-entries/${id}`, { name });
      setUserCatalogEntries((cur) => cur.map((c) => (c.id === id ? res.data : c)));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const deleteCustomEntry = async (id) => {
    try {
      await client.delete(`/user-catalog-entries/${id}`);
      setUserCatalogEntries((cur) => cur.filter((c) => c.id !== id));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
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
    // Selecting (or deselecting) a device always closes rack settings —
    // the two right-side panels never show at the same time.
    setRackEditOpen(false);
    setSelectedSlotId((cur) => (cur === slotId ? null : slotId));
  };

  // ─── JSON config backup (separate from new Export modal) ────────────────────
  const exportRackJson = (rackId) => {
    const rack = racks.find((r) => r.id === rackId);
    if (!rack) return;
    const slots = allSlots
      .filter((s) => s.rack_id === rackId)
      .map((s) => ({
        u_position: s.u_position,
        u_size: s.u_size,
        item_type: s.item_type,
        item_label: s.item_label,
        vendor: s.vendor,
        catalog_id: s.catalog_id,
        custom_type: s.custom_type,
        mounted_face: s.mounted_face,
        half_depth: s.half_depth,
        color: s.color,
        ip_address: s.ip_address,
        slot_notes: s.slot_notes,
        ...(s.hostname ? { device: { hostname: s.hostname, ip: s.ip, type: s.inv_device_type } } : {}),
      }));
    const data = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      rack: { name: rack.name, u_height: rack.u_height, rack_type: rack.rack_type, notes: rack.notes, show_rear: rack.show_rear, slots },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = `rack-${rack.name.trim().replace(/\s+/g, '-').toLowerCase() || 'rack'}.json`;
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ─── Export modal helpers ────────────────────────────────────────────────────
  const openExportModal = (targetRacks) => {
    if (!targetRacks || targetRacks.length === 0) return;
    setExportModal({ targetRacks });
  };

  // ─── Rename ──────────────────────────────────────────────────────────────────
  const handleRenameSubmit = async (rackId, name) => {
    setRenamingRackId(null);
    const rack = racks.find((r) => r.id === rackId);
    if (!rack || !name || name === rack.name) return;
    try {
      await client.put(`/racks/${rackId}`, { ...rack, name });
      loadRacks();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleRenameCancel = () => setRenamingRackId(null);

  // ─── Rack right-click context menu ──────────────────────────────────────────
  const handleRacksMainContextMenu = (e) => {
    const enclosure = e.target.closest('[id^="rack-"]');
    if (!enclosure) return;
    e.preventDefault();
    const rackId = parseInt(enclosure.id.replace('rack-', ''), 10);
    if (!rackId) return;
    setRackContextMenu({ rackId, x: e.clientX, y: e.clientY });
  };

  const ctxRack = rackContextMenu ? racks.find((r) => r.id === rackContextMenu.rackId) : null;

  const handleCtxDelete = () => {
    if (!ctxRack) return;
    setRackContextMenu(null);
    setDeleteConfirmRack(ctxRack);
  };

  const handleCtxToggleAnnotations = () => {
    if (!ctxRack) return;
    const turningOn = !ctxRack.show_annotations;
    // Auto-select "Name" as the annotation field when enabling for the first time
    const annotationField =
      turningOn && (!ctxRack.annotation_field || ctxRack.annotation_field === 'none')
        ? 'name'
        : ctxRack.annotation_field;
    actions.onRackSave(ctxRack.id, {
      ...ctxRack,
      show_annotations: turningOn ? 1 : 0,
      annotation_field: annotationField,
    });
  };

  const rightPanel = selectedSlot ? (
    <DevicePropertiesPanel
      slot={selectedSlot}
      rackHeight={selectedSlotRack?.u_height || 42}
      rackSlots={allSlots.filter((s) => s.rack_id === selectedSlot.rack_id)}
      allSlots={allSlots}
      racks={racks}
      userCatalogEntries={userCatalogEntries}
      devices={devices}
      actions={actions}
      onClose={() => setSelectedSlotId(null)}
      onUpdated={handleSlotUpdatedFromPanel}
      onSelectSlot={handleSelectSlot}
      onSaveToCatalog={saveSlotToCatalog}
      onDeleteRequest={(slot) => setDeleteConfirmSlot(slot)}
    />
  ) : (focusedRack && rackEditOpen) ? (
    <RackEditPanel
      rack={focusedRack}
      usedU={countUsedU(allSlots, focusedRack.id)}
      locations={locations}
      onClose={() => setRackEditOpen(false)}
      onSave={(edits) => actions.onRackSave(focusedRackId, edits)}
      onDuplicate={() => actions.onRackDuplicate(focusedRackId)}
      onDelete={() => actions.onRackDelete(focusedRackId)}
      onExport={() => openExportModal([focusedRack])}
      onExportJson={() => exportRackJson(focusedRackId)}
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
            disabled={racks.length === 0}
            onClick={() => openExportModal(racks)}
          >
            <Download size={14} /> Export…
          </button>
          <button
            type="button"
            disabled={!focusedRack}
            onClick={() => setUpsSummaryOpen(true)}
            title={focusedRack ? `UPS summary for ${focusedRack.name}` : 'Focus a rack to view UPS summary'}
          >
            <Zap size={14} /> Power Summary
          </button>
          <button type="button" className={catalogOpen ? 'active' : ''} onClick={() => setCatalogOpen((v) => !v)}>
            <LayoutGrid size={14} /> Device Catalog
          </button>
          <button type="button" className="primary" onClick={() => setAddRackOpen(true)}>
            <Plus size={14} /> Add Rack
          </button>
        </div>
      </div>

      <div className="racks-main" ref={racksMainRef} onContextMenu={handleRacksMainContextMenu}>
        {catalogOpen && (
          <DeviceCatalog
            open={catalogOpen}
            onClose={() => setCatalogOpen(false)}
            racks={racks}
            allSlots={allSlots}
            devices={devices}
            userCatalogEntries={userCatalogEntries}
            focusedRackId={focusedRackId}
            actions={actions}
            onRequestPlacement={requestPlacement}
            onCustomEntryRenamed={renameCustomEntry}
            onCustomEntryDeleted={deleteCustomEntry}
          />
        )}

        <RackCanvas
          racks={racks}
          allSlots={allSlots}
          userCatalogEntries={userCatalogEntries}
          highlightedSlotId={highlightedSlotId}
          selectedSlotId={selectedSlotId}
          actions={actions}
          onRequestPlacement={requestPlacement}
          focusedRackId={focusedRackId}
          onFocusRack={(rackId) => {
            // Single click on the rack frame / empty rack space: select that
            // rack for click-to-add, deselect any device, and never pop
            // open rack settings — that's reserved for a double click.
            setSelectedSlotId(null);
            setRackEditOpen(false);
            setFocusedRackId(rackId);
          }}
          onSelectSlot={handleSelectSlot}
          onEditRack={() => {
            setSelectedSlotId(null);
            setRackEditOpen((v) => !v);
          }}
          onOpenRackEdit={(rackId) => {
            // Double click on the rack frame: open rack settings, closing
            // the device panel first so only one panel is ever visible.
            setSelectedSlotId(null);
            setFocusedRackId(rackId);
            setRackEditOpen(true);
          }}
          rackEditOpen={rackEditOpen}
          fitRackRequest={fitRackRequest}
          renamingRackId={renamingRackId}
          onRenameSubmit={handleRenameSubmit}
          onRenameCancel={handleRenameCancel}
        />

        {rightPanel}
      </div>

      {rackContextMenu && ctxRack && (
        <RackContextMenu
          x={rackContextMenu.x}
          y={rackContextMenu.y}
          onClose={() => setRackContextMenu(null)}
          onExport={() => openExportModal([ctxRack])}
          onFocus={() => {
            setSelectedSlotId(null);
            setRackEditOpen(false);
            setFocusedRackId(ctxRack.id);
            setFitRackRequest({ id: ctxRack.id, t: Date.now() });
          }}
          onEditRack={() => {
            setSelectedSlotId(null);
            setFocusedRackId(ctxRack.id);
            setRackEditOpen(true);
          }}
          onRename={() => setRenamingRackId(ctxRack.id)}
          onDuplicate={() => actions.onRackDuplicate(ctxRack.id)}
          onDelete={handleCtxDelete}
          onToggleAnnotations={handleCtxToggleAnnotations}
          showAnnotations={Boolean(ctxRack.show_annotations)}
        />
      )}

      {exportModal && (
        <ExportModal
          targetRacks={exportModal.targetRacks}
          allSlots={allSlots}
          onClose={() => setExportModal(null)}
        />
      )}

      {upsSummaryOpen && focusedRack && (
        <UPSPowerSummary
          rack={focusedRack}
          allSlots={allSlots}
          onClose={() => setUpsSummaryOpen(false)}
        />
      )}

      {contextMenu && (
        <RackDeviceContextMenu
          slot={contextMenu.slot}
          x={contextMenu.x}
          y={contextMenu.y}
          devices={devices}
          onClose={() => setContextMenu(null)}
          onDeleteRequest={(slot) => setDeleteConfirmSlot(slot)}
          actions={actions}
        />
      )}

      {deleteConfirmSlot && (() => {
        const { name } = getDeviceLabel(deleteConfirmSlot);
        return (
          <ConfirmModal
            title={`Delete '${name}'?`}
            message="This action cannot be undone."
            confirmLabel="Delete"
            onConfirm={() => {
              actions.onSlotDelete(deleteConfirmSlot.id);
              setDeleteConfirmSlot(null);
            }}
            onCancel={() => setDeleteConfirmSlot(null)}
          />
        );
      })()}

      {deleteConfirmRack && (
        <ConfirmModal
          title={`Delete '${deleteConfirmRack.name}'?`}
          message="All devices in this rack will also be removed. This action cannot be undone."
          confirmLabel="Delete"
          onConfirm={() => {
            actions.onRackDelete(deleteConfirmRack.id);
            setDeleteConfirmRack(null);
          }}
          onCancel={() => setDeleteConfirmRack(null)}
        />
      )}

      {addRackOpen && <AddRackModal locations={locations} onClose={() => setAddRackOpen(false)} onCreate={handleAddRack} />}

      {pendingPlacement && (
        <QuickConfigModal pending={pendingPlacement} onConfirm={confirmPlacement} onCancel={cancelPlacement} />
      )}

      {portEditorDevice && (
        <PortEditorModal device={portEditorDevice} devices={devices} onClose={() => setPortEditorDevice(null)} />
      )}
    </div>
  );
}
