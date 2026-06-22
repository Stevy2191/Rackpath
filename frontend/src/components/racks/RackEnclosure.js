import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import DeviceBlock from './DeviceBlock';
import RackUnitSlot from './RackUnitSlot';
import VerticalPdu from './VerticalPdu';
import { countUsedU } from './rackPlacement';
import { layoutVerticalPdus, cordPathD, cordPathXs } from './verticalPduLayout';
import './RackEnclosure.css';

// Power cord traveling pulse: a lead dot plus a short comet tail of
// progressively smaller, fainter dots a few percent of the cord's own
// duration behind it — each is its own <animateMotion> on the exact same
// path as the lead, just delayed (a positive `begin`, so at any moment
// it's *earlier* along the path than the lead, i.e. behind it). Kept
// short (a few hundred ms against the 2.4s loop) so it reads as a tight
// spark trail, not a smear strung out across the whole cord.
const CORD_PULSE_DUR = 2.4;
const CORD_PULSE_TRAIL = [
  { delay: 0.07, r: 1.3, opacity: 0.5 },
  { delay: 0.14, r: 1.0, opacity: 0.32 },
  { delay: 0.21, r: 0.7, opacity: 0.18 },
  { delay: 0.28, r: 0.45, opacity: 0.09 },
];

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
    // Extend the run while each next element is exactly 1 more than the
    // *current* element — comparing against a separately-tracked `size`
    // instead (as this used to) drifts as soon as the run passes 2 rows,
    // since both the index and the running size advance together and get
    // double-counted, splitting any 3+-row run into multiple groups.
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const size = j - i + 1;
    result.set(start + size - 1, { u_position: start, u_size: size });
    i = j + 1;
  }
  return result;
}

// One face panel (front or rear)
function RackPanel({
  face,
  hidden,
  panelRef,
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
    <div ref={panelRef} className={`rack-panel-frame rack-panel-frame-${face}`} style={hidden ? { display: 'none' } : undefined}>
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
            // Enter this branch for a real ½W device starting here (hwRenderU)
            // *or* a ½W no-go stripe starting here — the latter needs no real
            // device on this face at all (e.g. a ½W half-depth device whose
            // projected stripe lands on an otherwise-empty opposite face), so
            // it can't be gated behind hwAtU like the real-device case is.
            if (hwRenderU.has(u) || hwStripesLeft.has(u) || hwStripesRight.has(u)) {
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
                    rackUHeight={rack.u_height}
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

            // ── Covered by a ½W no-go stripe at a higher topU, with no real
            //    device on this face at all (same "no sibling" case as above,
            //    just for a stripe instead of a real device) ────────────────
            if (hwStripesLeftCovered.has(u) || hwStripesRightCovered.has(u)) return null;

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
                rackUHeight={rack.u_height}
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
  onEditRackRequest,
  isFocused,
  uHeight,
  onSelectSlot,
  isRenaming,
  onRenameSubmit,
  onRenameCancel,
}) {
  const uRows = Array.from({ length: rack.u_height }, (_, i) => rack.u_height - i);
  const usedU = countUsedU(slots, rack.id);
  const freeU = rack.u_height - usedU;
  const showRear = rack.show_rear !== undefined ? Boolean(rack.show_rear) : true;

  // Vertical PDUs are floating elements alongside the frame, not part of the
  // front/rear U grid — keep them out of the U-occupancy maps entirely.
  const verticalPdus = slots.filter((s) => s.item_type === 'vertical-pdu');
  const uSlots = slots.filter((s) => s.item_type !== 'vertical-pdu');

  // Measure the dual-frame's intrinsic (untransformed) size so the cord
  // overlay's coordinates stay correct regardless of the canvas pan/zoom —
  // offsetWidth/Height are unaffected by ancestor CSS transforms. A
  // ResizeObserver (rather than a useLayoutEffect keyed on the props that
  // *should* affect frame size) means this also picks up size changes
  // React never triggered in the first place — e.g. the export modal
  // temporarily hiding one panel via a plain CSS class for a Front/Rear-
  // only capture, which previously left this stale at the full two-panel
  // width and threw off every left/right-edge PDU position computed from
  // it during that capture.
  const frameRef = useRef(null);
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const measure = () => setFrameSize({ width: el.offsetWidth, height: el.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Both vertical PDUs are mounted alongside the Front column specifically
  // (that's where the UPS they're plugged into lives) — Left floats off
  // Front's own left edge, Right floats off Front's own right edge, into
  // the gap before Rear. Measured separately from the dual-frame's overall
  // width (frameSize.width, above) for exactly that reason: with Rear
  // showing, the frame is wider than Front alone, and anchoring Right to
  // the *frame's* edge would put it beyond Rear instead of beside Front.
  // When Rear is hidden, Front *is* the frame's only content, so this
  // naturally comes out equal to frameSize.width — no separate case needed.
  const frontPanelRef = useRef(null);
  const [frontWidth, setFrontWidth] = useState(0);
  useLayoutEffect(() => {
    const el = frontPanelRef.current;
    if (!el) return;
    const measure = () => setFrontWidth(el.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // left/right + stack-out-from-the-frame assignment, position math, and
  // (for any PDU plugged into a UPS in this rack) its power cord's bezier
  // endpoints — all computed by the shared layout helper so the export
  // capture's off-screen renders use the exact same formulas live
  // rendering does.
  const pduLayout = layoutVerticalPdus({
    verticalPdus,
    uSlots,
    rack,
    uHeight,
    frontWidth,
    frameHeight: frameSize.height,
    hasGap: showRear,
  });

  // Stop rendering the cords' traveling pulse while this rack is scrolled
  // out of the viewport, so off-screen racks don't keep animating for
  // nothing. Unlike the old CSS-keyframe dash march, animateMotion (SMIL)
  // can't be paused via the animation-play-state trick, so this gates
  // whether the pulse element is rendered at all rather than its play state.
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

  // Same reasoning as cordsInView — prefers-reduced-motion can't disable a
  // SMIL animation via CSS the way it could the old @keyframes animation,
  // so it's checked in JS and used to skip rendering the pulse instead.
  const [reduceMotion, setReduceMotion] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const onChange = (e) => setReduceMotion(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // One cord per vertical PDU that's plugged into a UPS in this rack, drawn
  // as a cubic bezier rather than a straight line so it reads as a real
  // cable with some slack in it instead of a schematic connector line.
  // Endpoints go UPS → PDU (the actual direction power flows) so the
  // traveling-pulse animation's direction matches reality.
  const cords = [];
  for (const pdu of verticalPdus) {
    const { side, cord } = pduLayout.get(pdu.id);
    if (!cord) continue;
    cords.push({ key: pdu.id, resolvedSide: side, ...cord });
  }

  // The SVG itself has to actually span every point any cord touches —
  // `overflow: visible` looks fine live, but a left/right-positioned PDU's
  // curve (including its outward-bowing control points) sits outside the
  // svg's own [0, frameSize.width] box, and nested-svg overflow doesn't
  // reliably survive being rasterized through html-to-image's serialize-
  // then-redraw-as-an-<img> pipeline (export capture), so the cord silently
  // disappeared from exports despite rendering fine on screen. Shifting the
  // svg's own origin (and every coordinate in it) to the leftmost point in
  // use keeps everything within its declared bounds instead of relying on
  // overflow to paint outside them.
  const cordXs = cords.flatMap((c) => cordPathXs(c));
  const cordsSvgLeft  = Math.min(0, ...cordXs);
  const cordsSvgWidth = Math.max(frameSize.width, ...cordXs) - cordsSvgLeft;

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
      <div className={`rack-u-counter${freeU === 0 ? ' rack-u-counter-full' : ''}`}>
        {usedU}U used &middot; {freeU}U free
      </div>
      <div
        className="rack-dual-frame"
        ref={frameRef}
        style={{ '--u-height': `${uHeight}px` }}
        onClick={onFocus}
        onDoubleClick={onEditRackRequest}
      >
        <RackPanel
          face="front"
          panelRef={frontPanelRef}
          showLeftRail
          showRightRail
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
        {/* Always rendered, never conditionally omitted — Rear being
            hidden on screen is purely a display:none toggle on this same
            node, not the node's absence. That's what lets the export
            capture force Rear back on for Side-by-Side/Rear Only by
            overriding one style on its *clone*; if this were itself
            conditional, there'd be nothing in the live DOM to clone in
            the first place when Rear is off. */}
        <RackPanel
          face="rear"
          hidden={!showRear}
          showLeftRail
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
            className="rack-power-cords"
            style={{ left: cordsSvgLeft }}
            width={cordsSvgWidth}
            height={frameSize.height}
          >
            {cords.map((c) => {
              const d = cordPathD(c, cordsSvgLeft);
              return (
                <g key={c.key} className={`rack-power-cord rack-power-cord-${c.resolvedSide}`} data-pdu-id={c.key}>
                  {/* Soft outer glow: a wide, low-opacity stroke on the
                      centerline with a CSS `filter: blur(...)` — a real
                      blur (unlike a layered flat-opacity wash), and unlike
                      an SVG <filter>/feGaussianBlur *element*, a plain CSS
                      filter is just an inlined computed style, so it
                      actually survives the export capture's clone/
                      serialize step (the inline SVG defs+url() version
                      doesn't reliably carry over the way the rest of an
                      element's style does). */}
                  <path
                    d={d}
                    className="rack-power-cord-glow"
                    stroke="#f59e0b"
                    strokeWidth={7}
                    fill="none"
                    opacity={0.28}
                    style={{ filter: 'blur(2px)' }}
                  />
                  {/* The cord itself: a single solid line — coiled slack
                      hanging just past the UPS's own exit point, then one
                      clean run up to the PDU's bottom tip (see
                      verticalPduLayout.buildCordPath). Attributes are set
                      literally, not just via the CSS class, so the export
                      capture (which re-inlines computed styles when
                      cloning, but doesn't reliably carry over *external-
                      stylesheet* styling for nested svg content) still
                      shows it. */}
                  <path d={d} className="rack-power-cord-line" stroke="#f59e0b" strokeWidth={1.6} fill="none" />
                  {/* Traveling pulse + a short fading comet tail behind
                      it: only rendered while the rack is in view, since
                      SMIL/animateMotion can't be paused via the CSS
                      animation-play-state trick used for the old
                      marching-dashes animation — omitting the elements
                      entirely is what actually stops them from spending
                      render cycles off-screen. */}
                  {cordsInView && !reduceMotion && (
                    <>
                      {CORD_PULSE_TRAIL.map((t, i) => (
                        <g key={i} className="rack-power-cord-pulse-trail">
                          <animateMotion dur={`${CORD_PULSE_DUR}s`} begin={`${t.delay}s`} repeatCount="indefinite" path={d} />
                          <circle r={t.r} fill="#fbbf24" opacity={t.opacity} />
                        </g>
                      ))}
                      <g className="rack-power-cord-pulse">
                        <animateMotion dur={`${CORD_PULSE_DUR}s`} repeatCount="indefinite" path={d} />
                        <circle r={3.6} className="rack-power-cord-pulse-glow" fill="#fbbf24" opacity={0.35} />
                        <circle r={1.6} className="rack-power-cord-pulse-core" fill="#ffe3a3" />
                      </g>
                    </>
                  )}
                </g>
              );
            })}
          </svg>
        )}

        {verticalPdus.map((pdu) => {
          const { side, leftPx, top, height } = pduLayout.get(pdu.id);
          return (
            <VerticalPdu
              key={pdu.id}
              slot={pdu}
              side={side}
              leftPx={leftPx}
              top={top}
              height={height}
              isSelected={pdu.id === selectedSlotId}
              highlighted={pdu.id === highlightedSlotId}
              onSelect={onSelectSlot}
              actions={actions}
            />
          );
        })}
      </div>
    </div>
  );
}
