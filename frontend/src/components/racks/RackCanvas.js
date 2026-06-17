import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { Plus, Minus, Maximize2, Settings } from 'lucide-react';
import RackEnclosure from './RackEnclosure';
import CableOverlay from './CableOverlay';
import './RackCanvas.css';

const SIMPLE_ITEM_TYPES = ['patch-panel', 'blank', 'cable-manager'];

const U_HEIGHT    = 40;
const MIN_ZOOM    = 0.25;
const MAX_ZOOM    = 2.0;
const ZOOM_STEP   = 1.2;   // 20 % per button click / wheel tick
const FIT_PADDING = 48;    // px of breathing room around racks when fitting

function ZoomControls({ zoom, onZoomIn, onZoomOut, onFit }) {
  return (
    <div className="rack-zoom-controls">
      <button type="button" className="rack-zoom-btn" onClick={onZoomIn} title="Zoom in">
        <Plus size={13} />
      </button>
      <span className="rack-zoom-pct">{Math.round(zoom * 100)}%</span>
      <button type="button" className="rack-zoom-btn" onClick={onZoomOut} title="Zoom out">
        <Minus size={13} />
      </button>
      <div className="rack-zoom-sep" />
      <button type="button" className="rack-zoom-btn" onClick={onFit} title="Fit to screen">
        <Maximize2 size={13} />
      </button>
    </div>
  );
}

export default function RackCanvas({
  racks,
  allSlots,
  rackCustomDevices,
  highlightedSlotId,
  selectedSlotId,
  actions,
  cableViewEnabled,
  focusedRackId,
  onFocusRack,
  onSelectSlot,
  onEditRack,
  rackEditOpen,
  fitRackRequest,
  renamingRackId,
  onRenameSubmit,
  onRenameCancel,
}) {
  const [draggingMeta, setDraggingMeta] = useState(null);
  const [vp, setVp]       = useState({ zoom: 1, tx: 0, ty: 0 });
  const [fitted, setFitted]   = useState(false);
  const [isPanning, setIsPanning] = useState(false);

  const viewportRef = useRef(null);
  const contentRef  = useRef(null);
  const vpRef       = useRef(vp);       // always-current mirror for event handlers
  const panStart    = useRef(null);     // { x, y } offset at pan start

  // Update ref every render so event handlers always see fresh values.
  vpRef.current = vp;

  const applyVp = useCallback((next) => {
    vpRef.current = next;
    setVp(next);
  }, []);

  // ─── Fit-to-screen ──────────────────────────────────────────
  const fitToScreen = useCallback(() => {
    const el = viewportRef.current;
    const ct = contentRef.current;
    if (!el || !ct || ct.offsetWidth < 10) return;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    const cw = ct.offsetWidth;
    const ch = ct.offsetHeight;
    const newZoom = Math.max(
      MIN_ZOOM,
      Math.min(MAX_ZOOM, (vw - FIT_PADDING * 2) / cw, (vh - FIT_PADDING * 2) / ch),
    );
    const newTx = (vw - cw * newZoom) / 2;
    const newTy = Math.max((vh - ch * newZoom) / 2, FIT_PADDING);
    applyVp({ zoom: newZoom, tx: newTx, ty: newTy });
    setFitted(true);
  }, [applyVp]);

  // Fit to a specific rack (Focus action from context menu).
  useEffect(() => {
    if (!fitRackRequest) return;
    const rackEl = document.getElementById(`rack-${fitRackRequest.id}`);
    if (!rackEl || !viewportRef.current) return;
    const vpEl = viewportRef.current;
    const vw = vpEl.clientWidth;
    const vh = vpEl.clientHeight;
    const { tx, ty, zoom } = vpRef.current;
    const vpRect = vpEl.getBoundingClientRect();
    const elRect = rackEl.getBoundingClientRect();
    // Convert rack position from viewport coords to canvas-content coords
    const rackCX = (elRect.left - vpRect.left - tx) / zoom;
    const rackCY = (elRect.top  - vpRect.top  - ty) / zoom;
    const rackCW = elRect.width  / zoom;
    const rackCH = elRect.height / zoom;
    const FOCUS_PAD = 80;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
      (vw - FOCUS_PAD * 2) / rackCW,
      (vh - FOCUS_PAD * 2) / rackCH,
    ));
    applyVp({
      zoom: newZoom,
      tx: vw / 2 - (rackCX + rackCW / 2) * newZoom,
      ty: vh / 2 - (rackCY + rackCH / 2) * newZoom,
    });
  }, [fitRackRequest, applyVp]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fit once when racks first appear (runs before first visible paint).
  useLayoutEffect(() => {
    if (!fitted && racks.length > 0) fitToScreen();
  }, [racks.length, fitted, fitToScreen]);

  // Refit on window resize.
  useEffect(() => {
    window.addEventListener('resize', fitToScreen);
    return () => window.removeEventListener('resize', fitToScreen);
  }, [fitToScreen]);

  // ─── Scroll-wheel zoom (non-passive to allow preventDefault) ─
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      const { zoom: z, tx: x, ty: y } = vpRef.current;
      const factor  = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z * factor));
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      // Translate so the cursor point stays fixed in content space.
      const newTx = cx - (cx - x) / z * newZoom;
      const newTy = cy - (cy - y) / z * newZoom;
      applyVp({ zoom: newZoom, tx: newTx, ty: newTy });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyVp]);

  // ─── Pan: mousedown on empty canvas space ───────────────────
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    // Only pan if the target is the viewport background or content wrapper,
    // not a rack enclosure or device block.
    const t = e.target;
    if (t !== viewportRef.current && t !== contentRef.current) return;
    panStart.current = { x: e.clientX - vpRef.current.tx, y: e.clientY - vpRef.current.ty };
    setIsPanning(true);
  }, []);

  // Click (not drag) on empty canvas background → deselect rack.
  const handleCanvasClick = useCallback((e) => {
    const t = e.target;
    if (t === viewportRef.current || t === contentRef.current) {
      onFocusRack(null);
    }
  }, [onFocusRack]);

  useEffect(() => {
    if (!isPanning) return;
    const onMove = (e) => {
      if (!panStart.current) return;
      applyVp({
        ...vpRef.current,
        tx: e.clientX - panStart.current.x,
        ty: e.clientY - panStart.current.y,
      });
    };
    const onUp = () => { setIsPanning(false); panStart.current = null; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [isPanning, applyVp]);

  // ─── Zoom-button helper: zoom toward/from viewport center ───
  const zoomToCenter = useCallback((factor) => {
    const el = viewportRef.current;
    if (!el) return;
    const { zoom: z, tx: x, ty: y } = vpRef.current;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z * factor));
    const cx = el.clientWidth  / 2;
    const cy = el.clientHeight / 2;
    applyVp({
      zoom: newZoom,
      tx: cx - (cx - x) / z * newZoom,
      ty: cy - (cy - y) / z * newZoom,
    });
  }, [applyVp]);

  // ─── Drop handler (unchanged logic) ────────────────────────
  const handleDrop = (rackId, uPosition, face, e) => {
    e.preventDefault();
    setDraggingMeta(null);

    const slotId      = e.dataTransfer.getData('text/slot-id');
    const deviceId    = e.dataTransfer.getData('text/device-id');
    const catalogItem = e.dataTransfer.getData('text/catalog-item');
    const customDevId = e.dataTransfer.getData('text/custom-device-id');

    if (slotId) {
      const slot = allSlots.find((s) => String(s.id) === slotId);
      if (!slot) return;
      const u_position = uPosition - slot.u_size + 1;
      if (u_position < 1) return;
      const curFace = slot.mounted_face || slot.front_back || 'front';
      if (u_position === slot.u_position && slot.rack_id === rackId && curFace === face) return;
      actions.onSlotUpdate(slot, { rack_id: rackId, u_position, mounted_face: face });
      return;
    }

    if (deviceId) {
      const catalogRaw = e.dataTransfer.getData('text/device-catalog');
      const catalogMeta = catalogRaw ? JSON.parse(catalogRaw) : null;
      const u_size = catalogMeta?.uSize || 1;
      const mounted_face = catalogMeta?.mountedFace || face;
      const u_position = Math.max(1, uPosition - u_size + 1);
      actions.onSlotCreate({
        rack_id: rackId,
        device_id: Number(deviceId),
        item_type: 'device',
        u_position,
        u_size,
        mounted_face,
        half_depth: catalogMeta?.halfDepth ? 1 : 0,
        half_width: catalogMeta?.halfWidth ? 1 : 0,
        power_draw_w: catalogMeta?.powerDrawW,
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
        item_type: itemType,
        item_label: entry.name,
        vendor: entry.vendor,
        catalog_id: entry.id,
        custom_type: entry.renderType,
        u_position,
        u_size: entry.uSize,
        mounted_face: entry.mountedFace || face,
        half_depth: entry.halfDepth ? 1 : 0,
        half_width: entry.halfWidth ? 1 : 0,
        power_draw_w: entry.powerDrawW,
        outlet_count: entry.outletCount,
        outlet_type: entry.outletType,
        power_capacity: entry.capacity,
        power_capacity_unit: entry.capacityUnit,
        input_voltage: entry.inputVoltage,
      });
      return;
    }

    if (customDevId) {
      const custom = rackCustomDevices.find((c) => String(c.id) === customDevId);
      if (!custom) return;
      const u_position = uPosition - custom.u_size + 1;
      if (u_position < 1) return;
      actions.onSlotCreate({
        rack_id: rackId,
        item_type: 'custom-device',
        item_label: custom.name,
        vendor: custom.vendor,
        custom_type: custom.type,
        custom_image_url: custom.image_url,
        u_position,
        u_size: custom.u_size,
        mounted_face: face,
        power_draw_w: custom.power_draw_w,
        outlet_count: custom.outlet_count,
        outlet_type: custom.outlet_type,
        power_capacity: custom.power_capacity,
        power_capacity_unit: custom.power_capacity_unit,
        input_voltage: custom.input_voltage,
      });
    }
  };

  const sortedRacks = [...racks].sort((a, b) => a.id - b.id);

  return (
    <div
      className={`rack-canvas${isPanning ? ' rack-canvas-panning' : ''}`}
      ref={viewportRef}
      onMouseDown={handleMouseDown}
      onClick={handleCanvasClick}
    >
      <div
        className="rack-canvas-content"
        ref={contentRef}
        style={{
          transform: `translate(${vp.tx}px, ${vp.ty}px) scale(${vp.zoom})`,
          transformOrigin: '0 0',
          opacity: fitted ? 1 : 0,
          transition: 'opacity 0.15s ease',
        }}
      >
        {sortedRacks.map((rack) => (
          <RackEnclosure
            key={rack.id}
            rack={rack}
            slots={allSlots.filter((s) => s.rack_id === rack.id)}
            highlightedSlotId={highlightedSlotId}
            selectedSlotId={selectedSlotId}
            actions={actions}
            draggingMeta={draggingMeta}
            setDraggingMeta={setDraggingMeta}
            onDrop={handleDrop}
            onFocus={() => onFocusRack(rack.id)}
            isFocused={focusedRackId === rack.id}
            uHeight={U_HEIGHT}
            onSelectSlot={onSelectSlot}
            isRenaming={renamingRackId === rack.id}
            onRenameSubmit={(name) => onRenameSubmit(rack.id, name)}
            onRenameCancel={onRenameCancel}
          />
        ))}

        {cableViewEnabled && <CableOverlay racks={sortedRacks} allSlots={allSlots} />}
      </div>

      {focusedRackId && (
        <button
          type="button"
          className={`rack-edit-rack-btn${rackEditOpen ? ' active' : ''}`}
          onClick={onEditRack}
        >
          <Settings size={13} /> Edit Rack
        </button>
      )}

      <ZoomControls
        zoom={vp.zoom}
        onZoomIn={() => zoomToCenter(ZOOM_STEP)}
        onZoomOut={() => zoomToCenter(1 / ZOOM_STEP)}
        onFit={fitToScreen}
      />
    </div>
  );
}
