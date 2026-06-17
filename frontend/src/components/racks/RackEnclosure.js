import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import DeviceBlock from './DeviceBlock';
import RackUnitSlot from './RackUnitSlot';
import VerticalPdu from './VerticalPdu';
import './RackEnclosure.css';

// Vertical PDU floating-strip layout (must match the offsets VerticalPdu.js
// renders with — kept in JS so the cord overlay can use the same numbers).
// Offset is measured from the dual-frame's padding edge, so the visible gap
// from the rendered border ends up a little larger than STRIP_OFFSET_BASE -
// STRIP_WIDTH (border + padding add a few more px) — tuned to land in the
// 24-40px "floating, not attached" range the strip is meant to read as.
const STRIP_WIDTH = 14;
const STRIP_OFFSET_BASE = 40;
const STRIP_STACK_GAP = 24;

const ANNOTATION_LABELS = {
  name:         'Name',
  ip_address:   'IP Address',
  notes:        'Notes',
  asset_tag:    'Asset Tag',
  serial:       'Serial No.',
  manufacturer: 'Manufacturer',
};

function getAnnotationValue(slot, field) {
  switch (field) {
    case 'name':         return slot.item_label || slot.hostname || slot.ip || '';
    case 'ip_address':   return slot.ip_address || slot.ip || '';
    case 'notes':        return slot.slot_notes || '';
    case 'asset_tag':    return slot.asset_tag || '';
    case 'serial':       return slot.serial_number || '';
    case 'manufacturer': return slot.vendor || '';
    default:             return '';
  }
}

function resolveface(s) {
  if (s.mounted_face) return s.mounted_face;
  if (s.front_back === 'back' || s.side === 'back') return 'rear';
  if (s.side === 'both') return 'both';
  return 'front';
}

// Build a U-map for a given face.
//
// Returns:
//   fullByTop   – { [topU]: slot }  — full-width slots keyed by their topmost U
//   hwAtU       – Map<u, { left?, right? }>  — ½W slots whose range spans each U row
//   hwRenderU   – Set<u>  — U rows that need a split hw-row container rendered
//   covered     – Set<u>  — all occupied U rows (used for drag collision checks)
//   occupiedByU – Map<u, slotId>  — for drop highlight logic in RackUnitSlot
function buildUMap(slots, face) {
  const visible = slots.filter((s) => {
    const mf = resolveface(s);
    if (face === 'front') return mf === 'front' || mf === 'both';
    return mf === 'rear' || mf === 'both';
  });

  const fullByTop = {};
  const hwAtU = new Map();
  const covered = new Set();
  const occupiedByU = new Map();

  for (const s of visible) {
    const top = s.u_position + s.u_size - 1;
    for (let u = s.u_position; u <= top; u++) {
      covered.add(u);
      occupiedByU.set(u, s.id);
    }
    if (s.half_width) {
      const hp = s.half_position === 'right' ? 'right' : 'left';
      for (let u = s.u_position; u <= top; u++) {
        hwAtU.set(u, { ...(hwAtU.get(u) || {}), [hp]: s });
      }
    } else {
      fullByTop[top] = s;
    }
  }

  // hwRenderU: only U rows where at least one ½W device has its topU === u.
  // These are the rows where we render the hw-row split container.
  // Covered rows below a topU are handled by the tall DeviceBlock / explicit null.
  const hwRenderU = new Set();
  for (const [u, pair] of hwAtU) {
    const leftAtTop  = pair.left  && (pair.left.u_position  + pair.left.u_size  - 1 === u);
    const rightAtTop = pair.right && (pair.right.u_position + pair.right.u_size - 1 === u);
    if (leftAtTop || rightAtTop) hwRenderU.add(u);
  }

  return { fullByTop, hwAtU, hwRenderU, covered, occupiedByU };
}

// Groups a set of U row numbers into contiguous stripe blocks.
// Returns Map<topU, { u_position, u_size }>.
function groupStripeRows(rowSet) {
  if (rowSet.size === 0) return new Map();
  const sorted = [...rowSet].sort((a, b) => a - b);
  const result = new Map();
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i];
    let size = 1;
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + size) { size++; i++; }
    result.set(start + size - 1, { u_position: start, u_size: size });
    i++;
  }
  return result;
}

// One face panel (front or rear)
function RackPanel({
  face,
  showLeftRail,
  showRightRail,
  uRows,
  uHeight,
  rack,
  fullByTop,
  hwAtU,
  hwRenderU,
  covered,
  occupiedByU,
  fullStripes,    // Map<topU, {u_position,u_size}> — full-width half-depth stripes from opp. face
  hwStripesLeft,  // Map<topU, {u_position,u_size}> — ½W-left stripes
  hwStripesRight, // Map<topU, {u_position,u_size}> — ½W-right stripes
  highlightedSlotId,
  selectedSlotId,
  draggingMeta,
  setDraggingMeta,
  actions,
  onDrop,
  onSelectSlot,
}) {
  // Pre-compute which U rows are non-top rows of each stripe group (skip rendering there).
  const fullStripesCovered = new Set();
  for (const [topU, { u_position }] of fullStripes) {
    for (let u = u_position; u < topU; u++) fullStripesCovered.add(u);
  }
  const hwStripesLeftCovered = new Set();
  for (const [topU, { u_position }] of hwStripesLeft) {
    for (let u = u_position; u < topU; u++) hwStripesLeftCovered.add(u);
  }
  const hwStripesRightCovered = new Set();
  for (const [topU, { u_position }] of hwStripesRight) {
    for (let u = u_position; u < topU; u++) hwStripesRightCovered.add(u);
  }

  return (
    <div className={`rack-panel-frame rack-panel-frame-${face}`}>
      <div className="rack-panel-label">{face === 'front' ? 'FRONT' : 'REAR'}</div>
      <div className="rack-top-blank" />
      <div className="rack-body">
        {showLeftRail && (
          <div className="rack-rail rack-rail-left">
            {uRows.map((u) => (
              <div key={u} className={`rack-rail-number${u % 5 === 0 ? ' rack-rail-5th' : ''}`}>{u}</div>
            ))}
          </div>
        )}
        <div className="rack-units" key={face}>
          {uRows.map((u) => {
            // ── Full-width device at its topmost U ────────────────────────
            const fullSlot = fullByTop[u];
            if (fullSlot) {
              return (
                <DeviceBlock
                  key={`slot-${fullSlot.id}`}
                  slot={fullSlot}
                  side={face}
                  uHeight={uHeight}
                  highlighted={fullSlot.id === highlightedSlotId}
                  isSelected={fullSlot.id === selectedSlotId}
                  setDraggingMeta={setDraggingMeta}
                  actions={actions}
                  onSelect={onSelectSlot}
                />
              );
            }

            // ── Covered by a full-width multi-U device (non-top rows) ─────
            if (covered.has(u) && !hwAtU.has(u)) return null;

            // ── Half-width row: render a split container ──────────────────
            if (hwRenderU.has(u) || (hwAtU.has(u) && (hwStripesLeft.has(u) || hwStripesRight.has(u)))) {
              const pair = hwAtU.get(u) || {};
              const leftSlot  = pair.left;
              const rightSlot = pair.right;
              const leftAtTop  = leftSlot  && (leftSlot.u_position  + leftSlot.u_size  - 1 === u);
              const rightAtTop = rightSlot && (rightSlot.u_position + rightSlot.u_size - 1 === u);

              const leftStripe   = hwStripesLeft.get(u);
              const rightStripe  = hwStripesRight.get(u);
              const band = Math.floor((u - 1) / 5) % 2;
              const is5th = u % 5 === 0;

              // Row height = max u_size of devices that START at this topU
              let rowUSize = 1;
              if (leftAtTop)   rowUSize = Math.max(rowUSize, leftSlot.u_size);
              if (rightAtTop)  rowUSize = Math.max(rowUSize, rightSlot.u_size);
              if (leftStripe)  rowUSize = Math.max(rowUSize, leftStripe.u_size);
              if (rightStripe) rowUSize = Math.max(rowUSize, rightStripe.u_size);

              const renderHalfContent = (slot, slotAtTop, stripe, stripeCovered) => {
                if (slot && slotAtTop) {
                  return (
                    <DeviceBlock
                      key={`slot-${slot.id}`}
                      slot={slot}
                      side={face}
                      uHeight={uHeight}
                      highlighted={slot.id === highlightedSlotId}
                      isSelected={slot.id === selectedSlotId}
                      setDraggingMeta={setDraggingMeta}
                      actions={actions}
                      onSelect={onSelectSlot}
                    />
                  );
                }
                if (slot && !slotAtTop) return null; // covered by this half's multi-U device
                if (stripe) {
                  return (
                    <DeviceBlock
                      key={`hw-stripe-${u}`}
                      slot={{ id: `hw-stripe-${face}-${u}`, halfDepthStripe: true, u_position: stripe.u_position, u_size: stripe.u_size }}
                      side={face}
                      uHeight={uHeight}
                      highlighted={false}
                      isSelected={false}
                      setDraggingMeta={setDraggingMeta}
                      actions={actions}
                    />
                  );
                }
                if (stripeCovered) return null;
                return (
                  <RackUnitSlot
                    key={`hw-slot-${u}`}
                    u={u}
                    band={band}
                    is5th={is5th}
                    draggingMeta={draggingMeta}
                    occupiedByU={occupiedByU}
                    onDrop={(uPos, e) => onDrop(rack.id, uPos, face, e)}
                  />
                );
              };

              const leftContent  = renderHalfContent(leftSlot,  leftAtTop,  leftStripe,  hwStripesLeftCovered.has(u));
              const rightContent = renderHalfContent(rightSlot, rightAtTop, rightStripe, hwStripesRightCovered.has(u));

              // If both halves are null (covered rows with no sibling), skip the row.
              if (leftContent === null && rightContent === null) return null;

              return (
                <div key={`hw-row-${u}`} className="rack-hw-row" style={{ height: `${rowUSize * uHeight}px` }}>
                  <div className="rack-hw-half">{leftContent}</div>
                  <div className="rack-hw-half">{rightContent}</div>
                </div>
              );
            }

            // ── Covered by a ½W device at a higher topU (no sibling here) ─
            if (hwAtU.has(u)) return null;

            // ── Full-width half-depth stripe from opposite face ────────────
            if (fullStripesCovered.has(u)) return null;
            if (fullStripes.has(u)) {
              const { u_position, u_size } = fullStripes.get(u);
              return (
                <DeviceBlock
                  key={`stripe-${u}`}
                  slot={{ id: `stripe-${u}`, halfDepthStripe: true, u_position, u_size }}
                  side={face}
                  uHeight={uHeight}
                  highlighted={false}
                  isSelected={false}
                  setDraggingMeta={setDraggingMeta}
                  actions={actions}
                />
              );
            }

            // ── Empty full-width slot ──────────────────────────────────────
            const band = Math.floor((u - 1) / 5) % 2;
            return (
              <RackUnitSlot
                key={`unit-${u}`}
                u={u}
                band={band}
                is5th={u % 5 === 0}
                draggingMeta={draggingMeta}
                occupiedByU={occupiedByU}
                onDrop={(uPos, e) => onDrop(rack.id, uPos, face, e)}
              />
            );
          })}
        </div>
        {showRightRail && (
          <div className="rack-rail rack-rail-right">
            {uRows.map((u) => (
              <div key={u} className={`rack-rail-number${u % 5 === 0 ? ' rack-rail-5th' : ''}`}>{u}</div>
            ))}
          </div>
        )}
      </div>
      <div className="rack-bottom-blank" />
    </div>
  );
}

export default function RackEnclosure({
  rack,
  slots,
  highlightedSlotId,
  selectedSlotId,
  actions,
  draggingMeta,
  setDraggingMeta,
  onDrop,
  onFocus,
  isFocused,
  uHeight,
  onSelectSlot,
  isRenaming,
  onRenameSubmit,
  onRenameCancel,
}) {
  const uRows = Array.from({ length: rack.u_height }, (_, i) => rack.u_height - i);

  // Vertical PDUs are floating elements alongside the frame, not part of the
  // front/rear U grid — keep them out of the U-occupancy maps entirely.
  const verticalPdus = slots.filter((s) => s.item_type === 'vertical-pdu');
  const uSlots = slots.filter((s) => s.item_type !== 'vertical-pdu');

  // Stack index per side: 1st PDU on a side sits closest to the frame,
  // each later one on the same side floats further out.
  const stackIndexById = new Map();
  for (const side of ['left', 'right']) {
    verticalPdus
      .filter((p) => (p.mount_side === 'right' ? 'right' : 'left') === side)
      .sort((a, b) => a.id - b.id)
      .forEach((p, i) => stackIndexById.set(p.id, i));
  }

  // Measure the dual-frame's intrinsic (untransformed) size so the cord
  // overlay's coordinates stay correct regardless of the canvas pan/zoom —
  // offsetWidth/Height are unaffected by ancestor CSS transforms.
  const frameRef = useRef(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (frameRef.current) {
      setFrameSize({ width: frameRef.current.offsetWidth, height: frameRef.current.offsetHeight });
    }
  }, [rack.show_rear, rack.show_annotations, rack.annotation_field, rack.u_height, uHeight]);

  // Pause the cord "flow" animation while this rack is scrolled out of the
  // viewport, so off-screen racks don't keep animating for nothing.
  const [cordsInView, setCordsInView] = useState(true);
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setCordsInView(entry.isIntersecting),
      { rootMargin: '200px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function verticalCenterY(u_position, u_size) {
    const top = 16 + (rack.u_height - (u_position + u_size - 1)) * uHeight;
    return top + (u_size * uHeight) / 2;
  }

  // One cord per vertical PDU that's plugged into a UPS in this rack.
  // Endpoints are ordered UPS → PDU (the actual direction power flows,
  // since the PDU is plugged into the UPS) so the flow animation's
  // direction matches reality.
  const cords = [];
  for (const pdu of verticalPdus) {
    const ups = uSlots.find((s) => s.id === pdu.power_source_slot_id);
    if (!ups) continue;
    const side = pdu.mount_side === 'right' ? 'right' : 'left';
    const offsetPx = STRIP_OFFSET_BASE + (stackIndexById.get(pdu.id) || 0) * STRIP_STACK_GAP;
    const pduX = side === 'left' ? -offsetPx + STRIP_WIDTH / 2 : frameSize.width + offsetPx - STRIP_WIDTH / 2;
    const pduY = verticalCenterY(pdu.u_position, pdu.u_size);
    const upsX = side === 'left' ? 0 : frameSize.width;
    const upsY = verticalCenterY(ups.u_position, ups.u_size);
    cords.push({ key: pdu.id, x1: upsX, y1: upsY, x2: pduX, y2: pduY });
  }

  const frontMap = buildUMap(uSlots, 'front');
  const rearMap  = buildUMap(uSlots, 'rear');

  // Compute no-go stripes projected onto the opposite face:
  //   • Half-depth devices: occupy only the near half of the rack depth, so
  //     the opposite face still has room but gets a warning stripe.
  //   • Full-depth single-face devices: fill the entire rack depth, so the
  //     opposite face is completely blocked (stripe prevents drops there too).
  //   • 'both'-face devices: already render on both panels — no stripe needed.
  // ½W half-depth devices project onto the same half of the opposite face.
  function computeStripes(sourceFace, targetMap) {
    const fullRows    = new Set();
    const hwLeftRows  = new Set();
    const hwRightRows = new Set();

    for (const s of uSlots) {
      const mf = resolveface(s);
      const onSourceFace = sourceFace === 'front'
        ? (mf === 'front' || mf === 'both')
        : (mf === 'rear' || mf === 'both');
      if (!onSourceFace) continue;
      // 'both'-face devices render on both panels — no stripe needed.
      if (mf === 'both') continue;

      const top = s.u_position + s.u_size - 1;
      for (let u = s.u_position; u <= top; u++) {
        if (targetMap.covered.has(u)) continue;
        if (s.half_width) {
          const hp = s.half_position === 'right' ? 'right' : 'left';
          (hp === 'left' ? hwLeftRows : hwRightRows).add(u);
        } else {
          fullRows.add(u);
        }
      }
    }

    return {
      fullStripes:    groupStripeRows(fullRows),
      hwStripesLeft:  groupStripeRows(hwLeftRows),
      hwStripesRight: groupStripeRows(hwRightRows),
    };
  }

  const rearStripes  = computeStripes('front', rearMap);
  const frontStripes = computeStripes('rear',  frontMap);

  const panelProps = {
    uRows,
    uHeight,
    rack,
    highlightedSlotId,
    selectedSlotId,
    draggingMeta,
    setDraggingMeta,
    actions,
    onDrop,
    onSelectSlot,
  };

  const showRear        = rack.show_rear !== undefined ? Boolean(rack.show_rear) : true;
  const annotationField = (rack.annotation_field && rack.annotation_field !== 'none') ? rack.annotation_field : null;
  const showAnnotations = Boolean(rack.show_annotations) && Boolean(annotationField);

  // Merged top-U map for annotation column: front face takes priority over rear
  const annotationByTopU = { ...rearMap.fullByTop, ...frontMap.fullByTop };
  // Combined covered set for skipping non-top rows
  const annotationCovered = new Set([...frontMap.covered, ...rearMap.covered]);

  return (
    <div className={`rack-enclosure${isFocused ? ' rack-enclosure-focused' : ''}${!showRear ? ' rack-enclosure-single' : ''}`} id={`rack-${rack.id}`}>
      {isRenaming ? (
        <input
          className="rack-name-input"
          defaultValue={rack.name}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') { const v = e.target.value.trim(); onRenameSubmit(v || rack.name); }
            if (e.key === 'Escape') onRenameCancel();
          }}
          onBlur={(e) => onRenameSubmit(e.target.value.trim() || rack.name)}
          onContextMenu={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="rack-name-label">{rack.name}</div>
      )}
      <div className="rack-dual-frame" ref={frameRef} style={{ '--u-height': `${uHeight}px` }} onClick={onFocus}>
        <RackPanel
          face="front"
          showLeftRail
          showRightRail={!showRear}
          fullByTop={frontMap.fullByTop}
          hwAtU={frontMap.hwAtU}
          hwRenderU={frontMap.hwRenderU}
          covered={frontMap.covered}
          occupiedByU={frontMap.occupiedByU}
          fullStripes={frontStripes.fullStripes}
          hwStripesLeft={frontStripes.hwStripesLeft}
          hwStripesRight={frontStripes.hwStripesRight}
          {...panelProps}
        />
        {showRear && (
          <>
            <div className="rack-panel-divider" />
            <RackPanel
              face="rear"
              showLeftRail={false}
              showRightRail
              fullByTop={rearMap.fullByTop}
              hwAtU={rearMap.hwAtU}
              hwRenderU={rearMap.hwRenderU}
              covered={rearMap.covered}
              occupiedByU={rearMap.occupiedByU}
              fullStripes={rearStripes.fullStripes}
              hwStripesLeft={rearStripes.hwStripesLeft}
              hwStripesRight={rearStripes.hwStripesRight}
              {...panelProps}
            />
          </>
        )}

        {showAnnotations && (
          <div className="rack-annotation-col">
            <div className="rack-annotation-header">
              {ANNOTATION_LABELS[annotationField] || annotationField}
            </div>
            <div className="rack-annotation-top-pad" />
            <div className="rack-annotation-body">
              {uRows.map((u) => {
                const slot = annotationByTopU[u];
                if (slot) {
                  const text = getAnnotationValue(slot, annotationField);
                  return (
                    <div
                      key={u}
                      className="rack-annotation-cell"
                      style={{ height: slot.u_size * uHeight }}
                    >
                      {text && <span className="rack-annotation-text">{text}</span>}
                    </div>
                  );
                }
                // Skip rows covered by a multi-U device above (already rendered)
                if (annotationCovered.has(u)) return null;
                // Empty row
                return (
                  <div
                    key={u}
                    className="rack-annotation-cell"
                    style={{ height: uHeight }}
                  />
                );
              })}
            </div>
            <div className="rack-annotation-bottom-pad" />
          </div>
        )}

        {cords.length > 0 && (
          <svg
            className={`rack-power-cords${cordsInView ? '' : ' rack-power-cords-paused'}`}
            width={frameSize.width}
            height={frameSize.height}
          >
            {cords.map((c) => (
              <line key={c.key} x1={c.x1} y1={c.y1} x2={c.x2} y2={c.y2} className="rack-power-cord-line" />
            ))}
          </svg>
        )}

        {verticalPdus.map((pdu) => (
          <VerticalPdu
            key={pdu.id}
            slot={pdu}
            rack={rack}
            uHeight={uHeight}
            offsetPx={STRIP_OFFSET_BASE + (stackIndexById.get(pdu.id) || 0) * STRIP_STACK_GAP}
            isSelected={pdu.id === selectedSlotId}
            highlighted={pdu.id === highlightedSlotId}
            onSelect={onSelectSlot}
            actions={actions}
          />
        ))}
      </div>
    </div>
  );
}
