import React, { useLayoutEffect, useRef, useState } from 'react';
import { Plus, ZoomIn, ZoomOut } from 'lucide-react';
import RackEnclosure from './RackEnclosure';
import CableOverlay from './CableOverlay';
import './RackCanvas.css';

const SIMPLE_ITEM_TYPES = ['patch-panel', 'blank', 'cable-manager'];

const MIN_U_HEIGHT = 20;
const MAX_U_HEIGHT = 44;
const DEFAULT_U_HEIGHT = 32;

// Horizontal multi-rack canvas: one RackEnclosure per rack (sorted by id,
// oldest first), plus a trailing "+ Add Rack" card. Owns the shared
// drag-and-drop drop handler and the `draggingMeta` used for collision
// highlighting in empty slots.
export default function RackCanvas({
  racks,
  allSlots,
  rackCustomDevices,
  highlightedSlotId,
  actions,
  cableViewEnabled,
  focusedRackId,
  onFocusRack,
  onAddRack,
}) {
  const [draggingMeta, setDraggingMeta] = useState(null);
  const [uHeight, setUHeight] = useState(DEFAULT_U_HEIGHT);
  const canvasRef = useRef(null);

  const sortedRacks = [...racks].sort((a, b) => a.id - b.id);
  const maxUCount = Math.max(1, ...sortedRacks.map((r) => r.u_height || 42));

  // Auto-fit the U height so the tallest rack's full body fits in the
  // visible canvas without scrolling: available height = canvas height
  // minus its own padding minus each rack's fixed chrome (badge, frame
  // border/padding, blanking panels), divided by its U count.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const recompute = () => {
      const enclosure = canvas.querySelector('.rack-enclosure');
      const rackUnits = canvas.querySelector('.rack-units');
      if (!enclosure || !rackUnits) return;

      const chrome = enclosure.offsetHeight - rackUnits.offsetHeight;
      const style = window.getComputedStyle(canvas);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const available = canvas.clientHeight - padding - chrome;
      const next = Math.max(MIN_U_HEIGHT, Math.min(MAX_U_HEIGHT, Math.floor(available / maxUCount)));
      setUHeight((prev) => (prev === next ? prev : next));
    };

    recompute();
    const observer = new ResizeObserver(recompute);
    observer.observe(canvas);
    window.addEventListener('resize', recompute);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', recompute);
    };
  }, [maxUCount, sortedRacks.length]);

  const adjustZoom = (delta) => {
    setUHeight((h) => Math.max(MIN_U_HEIGHT, Math.min(MAX_U_HEIGHT, h + delta)));
  };

  const handleDrop = (rackId, uPosition, side, e) => {
    e.preventDefault();
    setDraggingMeta(null);

    const slotId = e.dataTransfer.getData('text/slot-id');
    const deviceId = e.dataTransfer.getData('text/device-id');
    const catalogItem = e.dataTransfer.getData('text/catalog-item');
    const customDeviceId = e.dataTransfer.getData('text/custom-device-id');

    if (slotId) {
      const slot = allSlots.find((s) => String(s.id) === slotId);
      if (!slot) return;
      const u_position = uPosition - slot.u_size + 1;
      if (u_position < 1) return;
      if (u_position === slot.u_position && slot.rack_id === rackId && (slot.front_back || 'front') === side) {
        return;
      }
      actions.onSlotUpdate(slot, { rack_id: rackId, u_position, front_back: side });
      return;
    }

    if (deviceId) {
      actions.onSlotCreate({
        rack_id: rackId,
        device_id: Number(deviceId),
        item_type: 'device',
        u_position: uPosition,
        u_size: 1,
        side: 'both',
        front_back: side,
      });
      return;
    }

    if (catalogItem) {
      const entry = JSON.parse(catalogItem);
      const itemType = SIMPLE_ITEM_TYPES.includes(entry.renderType) ? entry.renderType : 'custom-device';
      const u_position = uPosition - entry.uSize + 1;
      if (u_position < 1) return;
      actions.onSlotCreate({
        rack_id: rackId,
        device_id: null,
        item_type: itemType,
        item_label: entry.name,
        vendor: entry.vendor,
        catalog_id: entry.id,
        custom_type: entry.renderType,
        u_position,
        u_size: entry.uSize,
        side: 'both',
        front_back: side,
      });
      return;
    }

    if (customDeviceId) {
      const custom = rackCustomDevices.find((c) => String(c.id) === customDeviceId);
      if (!custom) return;
      const u_position = uPosition - custom.u_size + 1;
      if (u_position < 1) return;
      actions.onSlotCreate({
        rack_id: rackId,
        device_id: null,
        item_type: 'custom-device',
        item_label: custom.name,
        vendor: custom.vendor,
        custom_type: custom.type,
        custom_image_url: custom.image_url,
        u_position,
        u_size: custom.u_size,
        side: 'both',
        front_back: side,
      });
    }
  };

  return (
    <div className="rack-canvas" ref={canvasRef}>
      <div className="rack-zoom-control">
        <button type="button" onClick={() => adjustZoom(-2)} disabled={uHeight <= MIN_U_HEIGHT} title="Zoom out">
          <ZoomOut size={14} />
        </button>
        <button type="button" onClick={() => adjustZoom(2)} disabled={uHeight >= MAX_U_HEIGHT} title="Zoom in">
          <ZoomIn size={14} />
        </button>
      </div>

      {sortedRacks.map((rack) => (
        <RackEnclosure
          key={rack.id}
          rack={rack}
          slots={allSlots.filter((s) => s.rack_id === rack.id)}
          highlightedSlotId={highlightedSlotId}
          actions={actions}
          draggingMeta={draggingMeta}
          setDraggingMeta={setDraggingMeta}
          onDrop={handleDrop}
          onFocus={() => onFocusRack(rack.id)}
          isFocused={focusedRackId === rack.id}
          uHeight={uHeight}
        />
      ))}

      <button type="button" className="rack-add-card" onClick={onAddRack}>
        <Plus size={28} />
        <span>Add Rack</span>
      </button>

      {cableViewEnabled && <CableOverlay racks={sortedRacks} allSlots={allSlots} />}
    </div>
  );
}
