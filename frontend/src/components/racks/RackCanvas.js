import React, { useEffect, useRef, useState } from 'react';
import { Plus, ZoomIn, ZoomOut } from 'lucide-react';
import RackEnclosure from './RackEnclosure';
import CableOverlay from './CableOverlay';
import './RackCanvas.css';

const SIMPLE_ITEM_TYPES = ['patch-panel', 'blank', 'cable-manager'];

const MIN_U_HEIGHT = 18;
const MAX_U_HEIGHT = 44;
const DEFAULT_U_COUNT = 42;

// Non-unit chrome inside each rack enclosure (badge row, frame border/padding,
// top/bottom blanking panels) plus the canvas's own padding - subtracted from
// the canvas height to get the space actually available for U rows.
const RACK_CHROME_HEIGHT = 150;

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
  const [canvasHeight, setCanvasHeight] = useState(0);
  const [zoomOverride, setZoomOverride] = useState(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return undefined;
    const update = () => setCanvasHeight(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const sortedRacks = [...racks].sort((a, b) => a.id - b.id);

  // All racks share one U-height scale so a multi-rack row stays aligned.
  // It's based on the tallest rack, so every rack fits the available height
  // without vertical scrolling.
  const maxUCount = sortedRacks.reduce((max, r) => Math.max(max, r.u_height || 0), 0) || DEFAULT_U_COUNT;
  const availableHeight = canvasHeight - RACK_CHROME_HEIGHT;
  const autoUHeight =
    availableHeight > 0
      ? Math.max(MIN_U_HEIGHT, Math.min(MAX_U_HEIGHT, availableHeight / maxUCount))
      : MAX_U_HEIGHT;
  const uHeight = zoomOverride != null ? zoomOverride : autoUHeight;

  const adjustZoom = (delta) => {
    setZoomOverride(Math.max(MIN_U_HEIGHT, Math.min(MAX_U_HEIGHT, Math.round(uHeight) + delta)));
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
