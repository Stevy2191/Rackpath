// Pure layout math for floating vertical PDUs and their power cords —
// shared between RackEnclosure (live rendering) and ExportModal (off-
// screen single-column export captures), so both ever compute a PDU's
// position the same one way. None of this touches the DOM; callers are
// responsible for measuring the frame width they pass in and for turning
// the results into actual styles/attributes.
import { computeVerticalPduPositions } from './rackPlacement';

export const STRIP_WIDTH = 9;
export const STRIP_OFFSET_BASE = 40;
// Thin gap between the top and bottom PDU when 2 share one side's rail
// channel — they stack vertically (each gets half the channel's height),
// not side-by-side, so this is a vertical gap, not a horizontal offset.
export const STRIP_STACK_GAP = 6;
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
// Breathing room on each side of a channel's PDU-strip-width box — the
// channel's visible dashed outline (and its hit area for drag-and-drop)
// is wider than the strip itself. Shared so the export clone's relayout
// reproduces the exact same channel box the live render drew it from.
export const CHANNEL_PADDING = 5;

function bottomY(rack, uHeight, u_position, u_size) {
  const top = 16 + (rack.u_height - (u_position + u_size - 1)) * uHeight;
  return top + u_size * uHeight;
}

// Vertical PDU strip's own top/height. A side's full rail channel is
// centered within the rack's rendered pixel height (frameHeight — same
// local, untransformed coordinate space frameSize.height is measured in,
// so this scales correctly with canvas zoom along with everything else
// under the same transform instead of needing its own zoom correction).
// When 2 PDUs share a channel, each gets the top or bottom HALF of it
// (real vertical PDUs mount top-slot/bottom-slot within one rail, not
// side-by-side) — `stackCount` is how many PDUs are on this side total,
// `stackIndex` is this one's slot (0 = top, 1 = bottom).
export function pduBox(frameHeight, stackCount = 1, stackIndex = 0) {
  const channelHeight = frameHeight * PDU_HEIGHT_RATIO;
  const channelTop = (frameHeight - channelHeight) / 2;
  if (stackCount <= 1) return { top: channelTop, height: channelHeight };
  const slotHeight = (channelHeight - STRIP_STACK_GAP) / 2;
  const top = channelTop + stackIndex * (slotHeight + STRIP_STACK_GAP);
  return { top, height: slotHeight };
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

// Absolute left-edge offset (from Front's own left edge) for a given side
// — the single source of truth both the floating strip and its power
// cord's endpoint are computed from, so they always agree. Both sides are
// anchored relative to Front specifically (`frontWidth`), never Rear —
// that's where the UPS they're plugged into lives, and neither PDU should
// ever end up past Rear's own outer edge. `hasGap` is true only when Rear
// is actually present alongside Front (so there's a real gap to float a
// Right-side PDU in) — false for Rear hidden/absent, where Right instead
// floats the same fixed distance outside Front's edge that Left does
// outside its own. Top/bottom-stacked PDUs on the same side share this
// same horizontal position — see pduBox for how they split vertically.
export function pduLeftPx({ side }, frontWidth, hasGap) {
  if (side === 'left') return -STRIP_OFFSET_BASE;
  if (hasGap) {
    // Centered in the gap, with real breathing room on both sides, rather
    // than crowding up against either column's edge.
    return frontWidth + (PANEL_GAP - STRIP_WIDTH) / 2;
  }
  return frontWidth + STRIP_OFFSET_BASE - STRIP_WIDTH;
}

// Layout for the two side rail channels themselves — the always-present
// mounting zones a vertical PDU's strip floats inside, independent of
// whether anything currently occupies them (so an empty channel still has
// somewhere to render its placeholder/drop-zone indicator). Each channel
// spans the *full* height a single PDU would use (pduBox with stackCount
// 1), since the channel itself doesn't shrink just because it's empty or
// shared — only the PDU strips inside it split to fit.
//
// Returns { left: { leftPx, top, height, count }, right: { ... } }, where
// `count` is how many PDUs currently occupy that channel (0, 1, or 2).
export function computeChannelBoxes({ verticalPdus, frontWidth, frameHeight, hasGap }) {
  const assigned = computeVerticalPduPositions(verticalPdus);
  const counts = { left: 0, right: 0 };
  for (const { side } of assigned.values()) counts[side] += 1;

  const { top, height } = pduBox(frameHeight, 1, 0);
  return {
    left:  { leftPx: pduLeftPx({ side: 'left' },  frontWidth, hasGap), top, height, count: counts.left },
    right: { leftPx: pduLeftPx({ side: 'right' }, frontWidth, hasGap), top, height, count: counts.right },
  };
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
  const sideCounts = { left: 0, right: 0 };
  for (const { side } of assigned.values()) sideCounts[side] += 1;

  const result = new Map();
  for (const pdu of verticalPdus) {
    const { side, stack } = assigned.get(pdu.id);
    const leftPx = pduLeftPx({ side }, frontWidth, hasGap);
    const { top, height } = pduBox(frameHeight, sideCounts[side], stack);
    const pduBottomY = top + height;

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
