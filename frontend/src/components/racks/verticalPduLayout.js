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
function buildCordCurve(upsX, upsY, pduX, pduY, outward) {
  const dist = Math.hypot(pduX - upsX, pduY - upsY);
  const reach = Math.max(10, Math.min(40, dist * 0.3));
  const sag = Math.max(6, Math.min(28, dist * 0.18));

  const c1x = upsX + outward * reach * 0.45;
  const c1y = upsY + sag * 0.6;
  const c2x = pduX + outward * reach;
  const c2y = pduY + sag;

  return { upsX, upsY, c1x, c1y, c2x, c2y, pduX, pduY };
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
