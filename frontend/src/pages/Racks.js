import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Cable, ChevronDown, Download, LayoutGrid, Plus } from 'lucide-react';
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
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef(null);
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
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Close export dropdown on outside click
  useEffect(() => {
    if (!exportMenuOpen) return;
    const handler = (e) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [exportMenuOpen]);

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

  const exportSingleRack = async (rackId, format) => {
    const rack = racks.find((r) => r.id === rackId);
    if (!rack) return;
    // .rack-dual-frame is a direct child of #rack-<id> (.rack-enclosure)
    const frame = document.getElementById(`rack-${rackId}`)?.querySelector('.rack-dual-frame');
    if (!frame) return;
    const pixelRatio = window.devicePixelRatio || 2;
    setExportingRack(true);
    try {
      const dataUrl = await toPng(frame, { backgroundColor: '#0a0a0f', pixelRatio, width: frame.offsetWidth, height: frame.offsetHeight });
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

  const exportAllRacks = async (format) => {
    const sortedRacks = [...racks].sort((a, b) => a.id - b.id);
    const pixelRatio = window.devicePixelRatio || 2;
    setExportingRack(true);
    try {
      // id IS the .rack-enclosure element — use getElementById directly
      const capturePromises = sortedRacks.map((rack) => {
        const el = document.getElementById(`rack-${rack.id}`);
        if (!el) return Promise.resolve(null);
        return toPng(el, { backgroundColor: '#0a0a0f', pixelRatio, width: el.offsetWidth, height: el.offsetHeight }).then((dataUrl) => ({
          dataUrl,
          width: el.offsetWidth,
          height: el.offsetHeight,
        }));
      });
      const captures = (await Promise.all(capturePromises)).filter(Boolean);
      if (captures.length === 0) return;

      const GAP = 48;
      const PADDING = 32;
      const totalWidth = captures.reduce((sum, c) => sum + c.width, 0) + GAP * (captures.length - 1) + PADDING * 2;
      const maxHeight = Math.max(...captures.map((c) => c.height));
      const totalHeight = maxHeight + PADDING * 2;

      // Create canvas at physical pixel size for HiDPI sharpness
      const canvas = document.createElement('canvas');
      canvas.width = totalWidth * pixelRatio;
      canvas.height = totalHeight * pixelRatio;
      const ctx = canvas.getContext('2d');
      ctx.scale(pixelRatio, pixelRatio);
      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(0, 0, totalWidth, totalHeight);

      // Load all captured images in parallel, then composite in order
      const imgs = await Promise.all(
        captures.map(
          (cap) =>
            new Promise((resolve) => {
              const img = new Image();
              img.onload = () => resolve(img);
              img.src = cap.dataUrl;
            }),
        ),
      );

      let x = PADDING;
      for (let i = 0; i < captures.length; i++) {
        const y = PADDING + Math.floor((maxHeight - captures[i].height) / 2);
        // Draw at CSS pixel coords — context scale maps to physical pixels
        ctx.drawImage(imgs[i], x, y, captures[i].width, captures[i].height);
        x += captures[i].width + GAP;
      }

      const compositeDataUrl = canvas.toDataURL('image/png');
      if (format === 'pdf') {
        const pdf = new jsPDF({
          orientation: totalWidth >= totalHeight ? 'landscape' : 'portrait',
          unit: 'px',
          format: [totalWidth, totalHeight],
        });
        pdf.addImage(compositeDataUrl, 'PNG', 0, 0, totalWidth, totalHeight);
        pdf.save('racks-export.pdf');
      } else {
        const a = document.createElement('a');
        a.download = 'racks-export.png';
        a.href = compositeDataUrl;
        a.click();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Rack export failed', err);
    } finally {
      setExportingRack(false);
    }
  };

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
        ...(s.hostname ? { device: { hostname: s.hostname, ip: s.ip, type: s.device_type } } : {}),
      }));
    const data = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      rack: { name: rack.name, location: rack.location, u_height: rack.u_height, rack_type: rack.rack_type, notes: rack.notes, show_rear: rack.show_rear, slots },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = `rack-${rack.name.trim().replace(/\s+/g, '-').toLowerCase() || 'rack'}.json`;
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportAllRacksJson = () => {
    const sortedRacks = [...racks].sort((a, b) => a.id - b.id);
    const data = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      racks: sortedRacks.map((rack) => ({
        name: rack.name,
        location: rack.location,
        u_height: rack.u_height,
        rack_type: rack.rack_type,
        notes: rack.notes,
        show_rear: rack.show_rear,
        slots: allSlots
          .filter((s) => s.rack_id === rack.id)
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
            ...(s.hostname ? { device: { hostname: s.hostname, ip: s.ip, type: s.device_type } } : {}),
          })),
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = 'racks-export.json';
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportRack = (format) => {
    if (format === 'json') {
      if (racks.length > 1) exportAllRacksJson();
      else if (focusedRackId) exportRackJson(focusedRackId);
      return;
    }
    if (racks.length > 1) exportAllRacks(format);
    else if (focusedRackId) exportSingleRack(focusedRackId, format);
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
      rackSlots={allSlots.filter((s) => s.rack_id === focusedRackId)}
      onClose={() => setRackEditOpen(false)}
      onSave={(edits) => actions.onRackSave(focusedRackId, edits)}
      onDuplicate={() => actions.onRackDuplicate(focusedRackId)}
      onDelete={() => actions.onRackDelete(focusedRackId)}
      onExport={(format) => {
        if (format === 'json') exportRackJson(focusedRackId);
        else exportSingleRack(focusedRackId, format);
      }}
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
          <div className="rack-export-wrap" ref={exportMenuRef}>
            <button
              type="button"
              disabled={exportingRack || racks.length === 0 || (racks.length === 1 && !focusedRackId)}
              className={exportMenuOpen ? 'active' : ''}
              onClick={() => setExportMenuOpen((v) => !v)}
            >
              <Download size={14} /> Export <ChevronDown size={11} />
            </button>
            {exportMenuOpen && (
              <div className="rack-export-menu">
                <button type="button" onClick={() => { setExportMenuOpen(false); handleExportRack('png'); }}>
                  Export as Image (PNG)
                </button>
                <button type="button" onClick={() => { setExportMenuOpen(false); handleExportRack('pdf'); }}>
                  Export as PDF
                </button>
                <button type="button" onClick={() => { setExportMenuOpen(false); handleExportRack('json'); }}>
                  Export as JSON (config backup)
                </button>
              </div>
            )}
          </div>
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
