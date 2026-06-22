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

// Bezier circle/ellipse approximation constant — the standard distance
// (as a fraction of the radius) from an arc's endpoint to its control
// point that makes 4 cubic beziers trace a near-perfect ellipse.
const ELLIPSE_K = 0.5523;

// Appends one full closed loop (4 cubic arcs, tracing a complete ellipse)
// to `commands`, starting and ending at the *same* point (topX, topY) —
// the ellipse's own top — centered at (topX, topY + ry). Goes around to
// the `outward` side first (so it bulges away from the rack, matching
// the direction the rest of the cord bows), giving one coil ring of a
// loosely-wound cable.
function appendLoop(commands, topX, topY, rx, ry, outward) {
  const cx = topX;
  const cy = topY + ry;
  const kx = rx * ELLIPSE_K;
  const ky = ry * ELLIPSE_K;
  // top -> side (outward)
  commands.push({ cmd: 'C', x1: cx + outward * kx, y1: cy - ry, x2: cx + outward * rx, y2: cy - ky, x: cx + outward * rx, y: cy });
  // side -> bottom
  commands.push({ cmd: 'C', x1: cx + outward * rx, y1: cy + ky, x2: cx + outward * kx, y2: cy + ry, x: cx, y: cy + ry });
  // bottom -> side (inward)
  commands.push({ cmd: 'C', x1: cx - outward * kx, y1: cy + ry, x2: cx - outward * rx, y2: cy + ky, x: cx - outward * rx, y: cy });
  // side -> top (back to start)
  commands.push({ cmd: 'C', x1: cx - outward * rx, y1: cy - ky, x2: cx - outward * kx, y2: cy - ry, x: cx, y: cy - ry });
}

// A short, gentle bezier between two nearby points — used to bridge from
// one loop's top (where it closed back up) to the next loop's own top
// (which has drifted slightly), without an abrupt jump.
function appendConnector(commands, fromX, fromY, toX, toY) {
  commands.push({
    cmd: 'C',
    x1: fromX, y1: fromY + (toY - fromY) * 0.3,
    x2: toX, y2: toY - (toY - fromY) * 0.3,
    x: toX, y: toY,
  });
}

// Builds 3 progressively smaller coil loops climbing *upward* from
// `startX,startY` — a cable's own slack, neatly wound like a length of
// spring/slinky stood on its end rather than left loose on the ground.
// Each loop is a tall, narrow ellipse (ry > rx) so it reads as a coil
// viewed from the side rather than a flat ring, and each one's own top
// sits above the previous loop's top by less than a full loop-height so
// consecutive loops visibly overlap, with a slight outward drift per
// loop for depth. Returns the point the path continues from afterward
// (the smallest, topmost loop's own top).
function appendVerticalCoil(commands, startX, startY, outward, baseR) {
  const sizes = [1, 0.88, 0.78];
  const rx = baseR * 0.55;
  const ry = baseR * 1.15;
  let top = { x: startX, y: startY };
  sizes.forEach((scale, i) => {
    const loopRx = rx * scale;
    const loopRy = ry * scale;
    if (i > 0) {
      const nextTop = { x: top.x + outward * loopRx * 0.35, y: top.y - loopRy * 1.4 };
      appendConnector(commands, top.x, top.y, nextTop.x, nextTop.y);
      top = nextTop;
    }
    appendLoop(commands, top.x, top.y, loopRx, loopRy, outward);
  });
  return top;
}

// Builds the full power-cord path as a flat list of draw commands (one
// initial M, then a run of C's) — a vertical coil of slack (like a
// length of cable wound and stood on end) climbing up from just past the
// UPS's own exit point, then one clean curve to the PDU's bottom tip —
// rather than the single sweeping bezier this used to be. Kept as a
// plain command list (not a ready-made `d` string) so cordPathD can
// still apply an arbitrary X shift to every point in it afterward, the
// same way it always has.
//
// The coil's size scales with the cord's overall length, same reasoning
// as the old curve's reach/droop did: a short cord between a closely-
// spaced PDU and UPS gets a proportionally smaller coil than a long one.
function buildCordPath(upsX, upsY, pduX, pduY, outward) {
  const dist = Math.hypot(pduX - upsX, pduY - upsY);
  const baseR = Math.max(5, Math.min(11, dist * 0.09));
  const reach = Math.max(10, Math.min(36, dist * 0.28));

  const commands = [{ cmd: 'M', x: upsX, y: upsY }];

  // Small lead-in so the coil hangs just clear of the UPS's own exit
  // point (a brief dip) before climbing back up through the loops,
  // rather than starting right on top of the exit point.
  const coilStartX = upsX + outward * baseR * 0.4;
  const coilStartY = upsY + baseR * 0.5;
  appendConnector(commands, upsX, upsY, coilStartX, coilStartY);

  const coilExit = appendVerticalCoil(commands, coilStartX, coilStartY, outward, baseR);

  // One clean curve from the top of the coil to the PDU's bottom tip —
  // a gentle, fairly symmetric bow (whichever direction it actually has
  // to travel — the PDU's bottom tip isn't always below the UPS), not
  // the old curve's pronounced gravity droop, since the coil itself is
  // now what reads as the cable's slack.
  const span = pduY - coilExit.y;
  const c1x = coilExit.x + outward * reach * 0.55;
  const c1y = coilExit.y + span * 0.33;
  const c2x = pduX + outward * reach * 0.55;
  const c2y = pduY - span * 0.33;
  commands.push({ cmd: 'C', x1: c1x, y1: c1y, x2: c2x, y2: c2y, x: pduX, y: pduY });

  return commands;
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
// `uSlots`) its power cord's full path — a few coiled loops of slack
// hanging off the UPS's own exit point, then one clean curve up to the
// PDU's bottom tip.
//
// Returns Map<pduId, { side, stack, leftPx, top, height, cord: null | {
//   upsX, upsY, pduX, pduY, commands
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
      const outward = side === 'left' ? -1 : 1; // which way "away from the rack" is, for the coil/curve's bow
      const upsY = bottomY(rack, uHeight, ups.u_position, ups.u_size);

      cord = { upsX, upsY, pduX, pduY, commands: buildCordPath(upsX, upsY, pduX, pduY, outward) };
    }

    result.set(pdu.id, { side, stack, leftPx, top, height, cord });
  }
  return result;
}

// Renders a cord's command list (see buildCordPath) as an SVG path `d`
// string, shifting every coordinate left by `svgLeftShift` — used when
// the containing svg's own origin has been moved to keep negative-X
// content (a left-floating PDU) within its declared bounds instead of
// relying on overflow to paint outside them.
export function cordPathD(cord, svgLeftShift = 0) {
  return cord.commands.map((c) => (
    c.cmd === 'M'
      ? `M ${c.x - svgLeftShift} ${c.y}`
      : `C ${c.x1 - svgLeftShift} ${c.y1}, ${c.x2 - svgLeftShift} ${c.y2}, ${c.x - svgLeftShift} ${c.y}`
  )).join(' ');
}

// Every X coordinate the cord's path actually touches (move/curve
// endpoints *and* control points, since the coil's loops bulge further
// out than either anchor) — used to size the cords <svg> to fit the
// whole path, coil included, not just the UPS/PDU anchors.
export function cordPathXs(cord) {
  return cord.commands.flatMap((c) => (c.cmd === 'M' ? [c.x] : [c.x1, c.x2, c.x]));
}
