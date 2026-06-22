// Pure layout math for floating vertical PDUs and their power cords —
// shared between RackEnclosure (live rendering) and ExportModal (off-
// screen single-column export captures), so both ever compute a PDU's
// position the same one way. None of this touches the DOM; callers are
// responsible for measuring the frame width they pass in and for turning
// the results into actual styles/attributes.
import { computeVerticalPduPositions } from './rackPlacement';

export const STRIP_WIDTH = 9;
export const STRIP_OFFSET_BASE = 40;
export const STRIP_STACK_GAP = 24;
// Must match .rack-dual-frame's CSS `gap` — both vertical PDUs mount
// alongside the Front column (that's where the UPS they're plugged into
// lives), so a Right-side PDU floats in this gap rather than past Rear's
// own outer edge. Wide enough to center a strip in it with real breathing
// room on both sides (see pduLeftPx) rather than crowding either column.
export const PANEL_GAP = 65;
// Fixed per-U pixel height used everywhere a rack is rendered (live canvas
// and export) — not currently zoom-dependent, but kept here as the single
// source both RackCanvas and the export capture read it from.
export const DEFAULT_U_HEIGHT = 40;
// A vertical PDU's floating strip is sized off the rack's own rendered
// height, not whatever u_size happens to be stored on its slot — a real
// vertical PDU spans most (not all) of the rack regardless of how tall the
// rack is, so this is what makes a 42U rack's strip taller than an 8U
// rack's while both still read as "the same kind of object" relative to
// their own frame. Centered vertically in the remaining 1 - ratio gap.
export const PDU_HEIGHT_RATIO = 0.65;

function bottomY(rack, uHeight, u_position, u_size) {
  const top = 16 + (rack.u_height - (u_position + u_size - 1)) * uHeight;
  return top + u_size * uHeight;
}

// Vertical PDU strip's own top/height, centered within the rack's
// rendered pixel height (frameHeight — same local, untransformed
// coordinate space frameSize.height is measured in, so this scales
// correctly with canvas zoom along with everything else under the same
// transform instead of needing its own zoom correction).
export function pduBox(frameHeight) {
  const height = frameHeight * PDU_HEIGHT_RATIO;
  const top = (frameHeight - height) / 2;
  return { top, height };
}

// Bezier control points scaled to the actual distance between the cord's
// two anchors. Previously these were fixed pixel offsets (+16/+24 of sag,
// 18-36px of horizontal reach) regardless of how far apart the anchors
// actually were — fine for the long, U-position-driven gaps that used to
// be typical, but a short cord (now common since the PDU's own bottom tip
// no longer depends on its slot's u_size) would sag/bow by more than the
// gap itself, reading as the curve overshooting past either end. Scaling
// both by the anchors' own distance keeps the bow proportional at any
// length: short cord → tight curve, long cord → a wider bow.
//
// The droop itself is built around a single low point — `lowY`, strictly
// below *both* upsY and pduY, like a real cable sagging under its own
// weight rather than a level line with some bulge — and the two control
// points are deliberately uneven distances from it: c1 (the UPS end)
// only drops halfway to lowY, so the cord leaves the UPS at a shallow
// angle, while c2 (the PDU end) sits right at lowY, forcing the curve to
// still be near its deepest point just before the PDU and so rise into
// it steeply — the look of a cable anchored/supported at the PDU end
// rather than sagging evenly along its whole length.
function buildCordCurve(upsX, upsY, pduX, pduY, outward) {
  const dist = Math.hypot(pduX - upsX, pduY - upsY);
  const reach = Math.max(10, Math.min(40, dist * 0.3));
  const droop = Math.max(16, Math.min(48, dist * 0.24));
  const lowY = Math.max(upsY, pduY) + droop;

  const c1x = upsX + outward * reach * 0.4;
  const c1y = (upsY + lowY) / 2;
  const c2x = pduX + outward * reach;
  const c2y = lowY;

  return { upsX, upsY, c1x, c1y, c2x, c2y, pduX, pduY };
}

// Half the gap between the two parallel strands drawn for each cord (see
// cordStrandPaths) — suggests the cable's physical roundness rather than
// a flat schematic line.
export const CORD_STRAND_OFFSET = 1.4;

function unitPerpendicular(dx, dy, distance) {
  const len = Math.hypot(dx, dy) || 1;
  return { ox: (-dy / len) * distance, oy: (dx / len) * distance };
}

function bezierPoint(cord, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * mt * cord.upsX + 3 * mt * mt * t * cord.c1x + 3 * mt * t * t * cord.c2x + t * t * t * cord.pduX,
    y: mt * mt * mt * cord.upsY + 3 * mt * mt * t * cord.c1y + 3 * mt * t * t * cord.c2y + t * t * t * cord.pduY,
  };
}

// Derivative of the cubic bezier at t — its direction is the curve's own
// tangent there, used to offset perpendicular to the curve itself rather
// than to one fixed direction.
function bezierTangent(cord, t) {
  const mt = 1 - t;
  return {
    dx: 3 * mt * mt * (cord.c1x - cord.upsX) + 6 * mt * t * (cord.c2x - cord.c1x) + 3 * t * t * (cord.pduX - cord.c2x),
    dy: 3 * mt * mt * (cord.c1y - cord.upsY) + 6 * mt * t * (cord.c2y - cord.c1y) + 3 * t * t * (cord.pduY - cord.c2y),
  };
}

// How many points the offset strand polylines below are sampled at —
// plenty for a curve this gentle to still read as perfectly smooth once
// anti-aliased, while being simple, exact per-point geometry rather than
// an approximated offset curve.
const STRAND_SAMPLES = 24;

// A true per-point offset of the cord's curve, used to draw its two
// parallel strands — each sampled point is shifted perpendicular to the
// curve's *own local tangent* there, not one fixed direction for the
// whole curve. A single rigid shift (or even shifting just the two ends
// along their own local tangents) looks right while the curve stays
// close to a straight line, but this curve deliberately droops well off
// one (see buildCordCurve): far enough that anything less than a
// per-point offset visibly pinches the two "parallel" strands together
// partway along instead of keeping them apart the curve's whole length.
function offsetStrandPoints(cord, distance) {
  const pts = [];
  for (let i = 0; i <= STRAND_SAMPLES; i++) {
    const t = i / STRAND_SAMPLES;
    const p = bezierPoint(cord, t);
    const tangent = bezierTangent(cord, t);
    const { ox, oy } = unitPerpendicular(tangent.dx, tangent.dy, distance);
    pts.push({ x: p.x + ox, y: p.y + oy });
  }
  return pts;
}

// Absolute left-edge offset (from Front's own left edge) for a given
// side/stack — the single source of truth both the floating strip and its
// power cord's endpoint are computed from, so they always agree. Both
// sides are anchored relative to Front specifically (`frontWidth`), never
// Rear — that's where the UPS they're plugged into lives, and neither PDU
// should ever end up past Rear's own outer edge. `hasGap` is true only
// when Rear is actually present alongside Front (so there's a real gap to
// float a Right-side PDU in) — false for Rear hidden/absent, where Right
// instead floats the same fixed distance outside Front's edge that Left
// does outside its own.
export function pduLeftPx({ side, stack }, frontWidth, hasGap) {
  const offsetPx = STRIP_OFFSET_BASE + stack * STRIP_STACK_GAP;
  if (side === 'left') return -offsetPx;
  if (hasGap) {
    // Centered in the gap, with real breathing room on both sides, rather
    // than crowding up against either column's edge.
    return frontWidth + (PANEL_GAP - STRIP_WIDTH) / 2 + stack * STRIP_STACK_GAP;
  }
  return frontWidth + offsetPx - STRIP_WIDTH;
}

// Full layout for every vertical PDU in a rack: where its strip floats
// (left/top/height) and (if it's plugged into a UPS that's also in
// `uSlots`) the bezier control points for its power cord.
//
// Returns Map<pduId, { side, stack, leftPx, top, height, cord: null | {
//   upsX, upsY, c1x, c1y, c2x, c2y, pduX, pduY
// } }>.
export function layoutVerticalPdus({ verticalPdus, uSlots, rack, uHeight, frontWidth, frameHeight, hasGap }) {
  const assigned = computeVerticalPduPositions(verticalPdus);
  const { top, height } = pduBox(frameHeight);
  const pduBottomY = top + height;

  const result = new Map();
  for (const pdu of verticalPdus) {
    const { side, stack } = assigned.get(pdu.id);
    const leftPx = pduLeftPx({ side, stack }, frontWidth, hasGap);

    let cord = null;
    const ups = uSlots.find((s) => s.id === pdu.power_source_slot_id);
    if (ups) {
      // Bottom edge, not vertical center, for both ends — the cord plugs
      // in at the strip's own bottom tip and the UPS's own cord-exit
      // point, which reads as the bottom of its device block.
      const pduX = leftPx + STRIP_WIDTH / 2;
      const pduY = pduBottomY;

      // Left/right cords always enter from that outer edge of Front —
      // the boundary itself, not wherever the strip floats to — same as
      // Left's upsX=0 is Front's left edge, not the strip's own (negative)
      // position past it.
      const upsX = side === 'left' ? 0 : frontWidth;
      const outward = side === 'left' ? -1 : 1; // which way "away from the rack" is, for the curve's bow
      const upsY = bottomY(rack, uHeight, ups.u_position, ups.u_size);

      cord = buildCordCurve(upsX, upsY, pduX, pduY, outward);
    }

    result.set(pdu.id, { side, stack, leftPx, top, height, cord });
  }
  return result;
}

// Renders a cord's bezier as an SVG path `d` string, shifting every
// coordinate left by `svgLeftShift` — used when the containing svg's own
// origin has been moved to keep negative-X content (a left-floating PDU)
// within its declared bounds instead of relying on overflow to paint
// outside them.
export function cordPathD(cord, svgLeftShift = 0) {
  return `M ${cord.upsX - svgLeftShift} ${cord.upsY} `
    + `C ${cord.c1x - svgLeftShift} ${cord.c1y}, `
    + `${cord.c2x - svgLeftShift} ${cord.c2y}, `
    + `${cord.pduX - svgLeftShift} ${cord.pduY}`;
}

function polylineD(points, svgLeftShift) {
  return points.map(({ x, y }, i) => `${i === 0 ? 'M' : 'L'} ${x - svgLeftShift} ${y}`).join(' ');
}

// The two parallel-strand path `d` strings drawn on top of the glow/seam
// layers — one offset +CORD_STRAND_OFFSET, the other -CORD_STRAND_OFFSET,
// each a polyline through points sampled off the curve's own local
// tangent (see offsetStrandPoints) so they stay apart the curve's whole
// length instead of pinching together partway through.
export function cordStrandPaths(cord, svgLeftShift = 0) {
  return {
    strand1: polylineD(offsetStrandPoints(cord, CORD_STRAND_OFFSET), svgLeftShift),
    strand2: polylineD(offsetStrandPoints(cord, -CORD_STRAND_OFFSET), svgLeftShift),
  };
}
