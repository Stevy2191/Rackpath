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
// Fixed per-U pixel height used everywhere a rack is rendered (live canvas
// and export) — not currently zoom-dependent, but kept here as the single
// source both RackCanvas and the export capture read it from.
export const DEFAULT_U_HEIGHT = 40;
// Must match .rack-dual-frame's CSS `gap` — the middle vertical PDU slot is
// centered in this gap between the Front and Rear panels. Sized to leave
// ~28px of clear space on either side of the (9px-wide) strip rather than
// crowding it against either panel's edge.
export const PANEL_GAP = 65;
// A vertical PDU's floating strip is sized off the rack's own rendered
// height, not whatever u_size happens to be stored on its slot — a real
// vertical PDU spans most (not all) of the rack regardless of how tall the
// rack is, so this is what makes a 42U rack's strip taller than an 8U
// rack's while both still read as "the same kind of object" relative to
// their own frame. Centered vertically in the remaining 1 - ratio gap.
export const PDU_HEIGHT_RATIO = 0.65;

export function resolveFace(s) {
  if (s.mounted_face) return s.mounted_face;
  if (s.front_back === 'back' || s.side === 'back') return 'rear';
  if (s.side === 'both') return 'both';
  return 'front';
}

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

// Turns an assigned slot ({side, stack} from computeVerticalPduPositions)
// into the side/stack actually used for layout. 'middle' only has a literal
// gap to float in when both columns are showing — without a companion
// column (Rear hidden live, or either single-column export capture) there's
// no gap, so it renders beside the visible column's own right edge instead,
// parked one stack beyond any *real* right-side PDU so it can't land on top
// of one.
export function resolvePduSlot({ side, stack }, { hasMiddleGap, rightSideCount }) {
  if (side === 'middle' && !hasMiddleGap) return { side: 'right', stack: rightSideCount };
  return { side, stack };
}

// Absolute left-edge offset (from the frame's own left edge) for a given
// resolved side/stack — the single source of truth both the floating strip
// and its power cord's endpoint are computed from, so they always agree.
export function pduLeftPx({ side, stack }, frameWidth) {
  const offsetPx = STRIP_OFFSET_BASE + stack * STRIP_STACK_GAP;
  if (side === 'left') return -offsetPx;
  if (side === 'right') return frameWidth + offsetPx - STRIP_WIDTH;
  // Middle: centered in the gap between the Front and Rear panels — the
  // only spot a real centerline PDU could physically occupy, so (unlike
  // left/right) it never stacks multiple strips.
  const halfWidth = (frameWidth - PANEL_GAP) / 2;
  return halfWidth + PANEL_GAP / 2 - STRIP_WIDTH / 2;
}

// Full layout for every vertical PDU in a rack: where its strip floats
// (left/top/height) and (if it's plugged into a UPS that's also in
// `uSlots`) the bezier control points for its power cord. `hasMiddleGap`
// should be true only when both Front and Rear are actually present in
// whatever's being laid out (live rendering with Rear shown, or a
// Side-by-Side export capture) — false for Rear hidden live, or a Front
// Only/Rear Only single-column capture.
//
// Returns Map<pduId, { side, stack, leftPx, top, height, cord: null | {
//   upsX, upsY, c1x, c1y, c2x, c2y, pduX, pduY
// } }>.
export function layoutVerticalPdus({ verticalPdus, uSlots, rack, uHeight, frameWidth, frameHeight, hasMiddleGap }) {
  const assigned = computeVerticalPduPositions(verticalPdus);
  const rightSideCount = [...assigned.values()].filter((p) => p.side === 'right').length;
  const { top, height } = pduBox(frameHeight);
  const pduBottomY = top + height;

  const result = new Map();
  for (const pdu of verticalPdus) {
    const slot = assigned.get(pdu.id);
    const resolved = resolvePduSlot(slot, { hasMiddleGap, rightSideCount });
    const leftPx = pduLeftPx(resolved, frameWidth);

    let cord = null;
    const ups = uSlots.find((s) => s.id === pdu.power_source_slot_id);
    if (ups) {
      // Bottom edge, not vertical center, for both ends — the cord plugs
      // in at the strip's own bottom tip and the UPS's own cord-exit
      // point, which reads as the bottom of its device block.
      const pduX = leftPx + STRIP_WIDTH / 2;
      const pduY = pduBottomY;

      // Left/right cords always enter from that outer edge of the frame
      // being laid out. A middle cord has no outer edge to default to, so
      // it attaches to whichever panel the UPS actually lives on, on the
      // edge facing the gap — the only edge that makes physical sense for
      // a centerline PDU.
      let upsX;
      let outward; // which way "away from the rack" is, for the curve's bow
      if (resolved.side === 'left') { upsX = 0; outward = -1; }
      else if (resolved.side === 'right') { upsX = frameWidth; outward = 1; }
      else {
        const halfWidth = (frameWidth - PANEL_GAP) / 2;
        const upsOnRear = resolveFace(ups) === 'rear';
        upsX = upsOnRear ? halfWidth + PANEL_GAP : halfWidth;
        outward = upsOnRear ? -1 : 1;
      }
      const upsY = bottomY(rack, uHeight, ups.u_position, ups.u_size);

      cord = buildCordCurve(upsX, upsY, pduX, pduY, outward);
    }

    result.set(pdu.id, { side: resolved.side, stack: resolved.stack, leftPx, top, height, cord });
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
