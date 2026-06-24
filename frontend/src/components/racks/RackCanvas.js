import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { Plus, Minus, Maximize2, Settings } from 'lucide-react';
import RackEnclosure from './RackEnclosure';
import CrossRackPowerOverlay from './CrossRackPowerOverlay';
import {
  resolveUPosition, isSpanFree, buildOccupiedSet, normalizeSlotWidth, resolveFractionalPlacement,
  resolveVerticalPduSide,
} from './rackPlacement';
import { DEFAULT_U_HEIGHT } from './verticalPduLayout';
import './RackCanvas.css';

const U_HEIGHT    = DEFAULT_U_HEIGHT;
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
  userCatalogEntries,
  highlightedSlotId,
  selectedSlotIds,
  actions,
  onRequestPlacement,
  focusedRackId,
  onFocusRack,
  onSelectSlot,
  onEditRack,
  onOpenRackEdit,
  rackEditOpen,
  fitRackRequest,
  renamingRackId,
  onRenameSubmit,
  onRenameCancel,
  showPowerConnections = true,
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

  // ─── Drop handler ───────────────────────────────────────────
  const handleDrop = (rackId, uPosition, face, e) => {
    e.preventDefault();
    setDraggingMeta(null);

    const slotId      = e.dataTransfer.getData('text/slot-id');
    const deviceId    = e.dataTransfer.getData('text/device-id');
    const catalogItem = e.dataTransfer.getData('text/catalog-item');
    const customDevId = e.dataTransfer.getData('text/custom-device-id');
    const rack = racks.find((r) => r.id === rackId);
    if (!rack) return;

    const resolvePosition = (uSize, targetFace, excludeId) => {
      const occupied = buildOccupiedSet(allSlots, rackId, targetFace, excludeId);
      return resolveUPosition(uPosition, uSize, rack.u_height, (pos) => isSpanFree(pos, uSize, occupied));
    };

    // Fractional-width devices (Mini PC, Regular PC, ...) are always
    // resolved against the EXACT row dropped on, not the generic
    // anchor-direction search above (which has no concept of sharing a row
    // — see buildOccupiedSet's docstring) - they either join that row's
    // existing compatible siblings at the next open column, start a fresh
    // group there if it's empty, or (when `rejectIfFull`) are rejected
    // outright with a friendly message instead of silently landing
    // somewhere else. Only meaningfully accurate for 1U devices, which is
    // all the catalog ships today — a manually multi-U-resized fractional
    // device only has its *first* row's compatibility checked here; the
    // backend's collision check remains authoritative either way.
    const resolveFractionalDropU = (excludeId, slotWidth, rejectIfFull) => {
      const width = normalizeSlotWidth(slotWidth);
      if (width !== 'full') {
        const result = resolveFractionalPlacement({
          slots: allSlots, rackId, face, uPosition, slotWidth: width, excludeSlotId: excludeId,
        });
        if (result.ok) return { u_position: result.u_position, slot_position: result.slot_position };
        if (rejectIfFull && result.reason === 'full') return { rejected: result.error };
        // 'incompatible' (or 'full' when not rejecting outright, e.g. the
        // tentative target before a quick-config modal even opens) falls
        // back to the generic search below, same as any other collision.
      }
      return { u_position: resolvePosition(1, face, excludeId), slot_position: 0 };
    };

    if (slotId) {
      const slot = allSlots.find((s) => String(s.id) === slotId);
      if (!slot) return;
      // Vertical PDUs only ever move via a side rail channel's own drop
      // target (RackEnclosure's PduChannel -> handleDropChannel below) —
      // they have no mounted_face/U-row to resolve here at all, so a drag
      // that lands on the ordinary U grid (e.g. dropped slightly off a
      // channel) is simply ignored rather than misfiled onto a U row.
      if (slot.item_type === 'vertical-pdu') return;
      const isFractional = normalizeSlotWidth(slot.slot_width) !== 'full';
      const resolved = isFractional
        ? resolveFractionalDropU(slot.id, slot.slot_width, true)
        : { u_position: resolvePosition(slot.u_size, face, slot.id) };
      if (resolved.rejected) {
        actions.onPlacementRejected?.(resolved.rejected);
        return;
      }
      const { u_position, slot_position } = resolved;
      const curFace = slot.mounted_face || slot.front_back || 'front';
      if (u_position === slot.u_position && slot.rack_id === rackId && curFace === face
        && (!isFractional || slot_position === (Number(slot.slot_position) || 0))) return;
      actions.onSlotUpdate(slot, {
        rack_id: rackId, u_position, mounted_face: face,
        ...(isFractional ? { slot_position } : {}),
      });
      return;
    }

    if (deviceId) {
      const catalogRaw = e.dataTransfer.getData('text/device-catalog');
      const catalogMeta = catalogRaw ? JSON.parse(catalogRaw) : null;
      const u_size = catalogMeta?.uSize || 1;
      const mounted_face = catalogMeta?.mountedFace || face;
      const slotWidth = catalogMeta?.slotWidth || 'full';
      const resolved = resolveFractionalDropU(null, slotWidth, true);
      if (resolved.rejected) {
        actions.onPlacementRejected?.(resolved.rejected);
        return;
      }
      actions.onSlotCreate({
        rack_id: rackId,
        device_id: Number(deviceId),
        item_type: 'device',
        u_position: resolved.u_position,
        u_size,
        mounted_face,
        half_depth: catalogMeta?.halfDepth ? 1 : 0,
        slot_width: slotWidth,
        slot_position: resolved.slot_position,
      });
      return;
    }

    if (catalogItem) {
      const entry = JSON.parse(catalogItem);
      const mounted_face = entry.mountedFace || face;
      // Tentative target for the quick-config modal — not the final
      // accept/reject decision, which confirmPlacement re-resolves with
      // fresh data once the user actually clicks "Place".
      const resolved = resolveFractionalDropU(null, entry.slotWidth, false);
      onRequestPlacement({ source: 'catalog', entry, target: { rack_id: rackId, u_position: resolved.u_position, mounted_face } });
      return;
    }

    if (customDevId) {
      const custom = userCatalogEntries.find((c) => String(c.id) === customDevId);
      if (!custom) return;
      const mounted_face = custom.mounted_face || face;
      const u_position = resolvePosition(custom.u_size, mounted_face, null);
      onRequestPlacement({ source: 'custom', entry: custom, target: { rack_id: rackId, u_position, mounted_face } });
    }
  };

  // ─── Vertical PDU drop (onto a side rail channel) ────────────
  // A separate path from handleDrop: vertical PDUs are 0U floating
  // elements, dropped onto one of the two channel zones flanking the
  // U grid (see RackEnclosure's PduChannel), not onto a U row — there's
  // no `uPosition`/`face` here, just which rack and which side. Handles
  // both a NEW placement from the catalog (text/vertical-pdu-item) and
  // repositioning an EXISTING PDU dragged from its own strip
  // (text/slot-id, same key handleDrop's move path uses — VerticalPdu
  // sets it on its own drag handle).
  const handleDropChannel = (rackId, side, e) => {
    const rack = racks.find((r) => r.id === rackId);
    if (!rack) return;

    const slotId = e.dataTransfer.getData('text/slot-id');
    if (slotId) {
      const slot = allSlots.find((s) => String(s.id) === slotId);
      if (!slot || slot.item_type !== 'vertical-pdu') return;
      const resolved = resolveVerticalPduSide({
        verticalPdus: allSlots.filter((s) => s.item_type === 'vertical-pdu' && s.rack_id === rackId),
        side,
        excludeSlotId: slot.id,
      });
      if (!resolved.ok) {
        actions.onPlacementRejected?.(resolved.error);
        return;
      }
      if (slot.rack_id === rackId && slot.mount_side === resolved.side) return;
      actions.onSlotUpdate(slot, { rack_id: rackId, mount_side: resolved.side });
      return;
    }

    const catalogRaw = e.dataTransfer.getData('text/vertical-pdu-item');
    if (!catalogRaw) return;
    const entry = JSON.parse(catalogRaw);

    const resolved = resolveVerticalPduSide({
      verticalPdus: allSlots.filter((s) => s.item_type === 'vertical-pdu' && s.rack_id === rackId),
      side,
    });
    if (!resolved.ok) {
      actions.onPlacementRejected?.(resolved.error);
      return;
    }

    // Half the rack's height, anchored at the top — matches the sizing the
    // UPS-side "Add Vertical PDU" flow has always used (DevicePropertiesPanel's
    // VerticalPduSection): a real 0U strip doesn't span floor-to-ceiling, and
    // leaving the bottom half open gives a same-rack power cord's curve down
    // to the UPS room to actually read as a curve.
    const u_size = Math.max(1, Math.round(rack.u_height * 0.5));
    const u_position = rack.u_height - u_size + 1;

    actions.onSlotCreate({
      rack_id: rackId,
      item_type: 'vertical-pdu',
      item_label: entry.name,
      catalog_id: entry.id,
      custom_type: entry.renderType,
      u_position,
      u_size,
      mount_side: resolved.side,
      outlet_groups: entry.outletCount ? [{ type: entry.outletType || 'Other', count: entry.outletCount }] : [],
      input_voltage: entry.inputVoltage || null,
    });
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
        {sortedRacks.map((rack, idx) => (
          <React.Fragment key={rack.id}>
            {idx > 0 && <div className="rack-column-separator" />}
            <RackEnclosure
              rack={rack}
              slots={allSlots.filter((s) => s.rack_id === rack.id)}
              highlightedSlotId={highlightedSlotId}
              selectedSlotIds={selectedSlotIds}
              actions={actions}
              draggingMeta={draggingMeta}
              setDraggingMeta={setDraggingMeta}
              onDrop={handleDrop}
              onDropChannel={handleDropChannel}
              showPowerConnections={showPowerConnections}
              onFocus={() => onFocusRack(rack.id)}
              onEditRackRequest={() => onOpenRackEdit(rack.id)}
              isFocused={focusedRackId === rack.id}
              uHeight={U_HEIGHT}
              onSelectSlot={onSelectSlot}
              isRenaming={renamingRackId === rack.id}
              onRenameSubmit={(name) => onRenameSubmit(rack.id, name)}
              onRenameCancel={onRenameCancel}
            />
          </React.Fragment>
        ))}

        <CrossRackPowerOverlay
          allSlots={allSlots}
          contentRef={contentRef}
          vp={vp}
          enabled={showPowerConnections}
        />
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
