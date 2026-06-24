// Shared helpers for placing a multi-U device relative to the rack row it
// was dropped on.
//
// Drops are normally anchored so the drop row becomes the device's topmost
// U (the device extends downward from the cursor). That anchoring can push
// the device past U1 (the bottom of the rack) or, when the row directly
// below the drop point is already occupied (e.g. dropping on the empty row
// right above an existing device to stack on top of it), into a collision
// that a bottom-anchored placement at the same drop point would have
// avoided. `resolveUPosition` tries the top-anchored position first and
// falls back to bottom-anchored (device extends upward from the cursor)
// whenever that avoids the problem, so the device still lands at the drop
// point as long as the rack has room in either direction.

function clampToRackRange(pos, uSize, rackUHeight) {
  return Math.max(1, Math.min(rackUHeight - uSize + 1, pos));
}

// isFree(pos) must report whether the uSize-tall span starting at `pos` is
// free of collisions (excluding the slot being moved, if any).
export function resolveUPosition(dropU, uSize, rackUHeight, isFree) {
  const topAnchored = clampToRackRange(dropU - uSize + 1, uSize, rackUHeight);
  if (isFree(topAnchored)) return topAnchored;

  const bottomAnchored = clampToRackRange(dropU, uSize, rackUHeight);
  if (isFree(bottomAnchored)) return bottomAnchored;

  return topAnchored;
}

export function isSpanFree(pos, uSize, occupied) {
  for (let u = pos; u < pos + uSize; u++) {
    if (occupied.has(u)) return false;
  }
  return true;
}

// Fractional-width U slots: "half-width" splits a U into 2 equal columns,
// "third" into 3 - up to that many same-width devices can share one U side
// by side. Anything else (including missing/unrecognized values) is "full".
export const FRACTIONAL_WIDTHS = ['half-width', 'third'];
export const SLOT_WIDTH_COLUMNS = { 'half-width': 2, third: 3 };

export function normalizeSlotWidth(width) {
  return FRACTIONAL_WIDTHS.includes(width) ? width : 'full';
}

export function slotWidthLabel(width) {
  if (width === 'half-width') return 'half-width';
  if (width === 'third') return 'third-width';
  return 'full-width';
}

// Resolves where a NEW fractional-width device should land at the exact U
// row it was dropped/clicked on, without ever falling back to a different
// row — fractional placement either joins the exact target row (if empty,
// or already holds compatible same-width siblings with an open column) or
// is rejected outright, so the caller can either share the modal flow's
// generic collision search (for "full" widths and for an incompatible exact
// row) or surface a specific rejection message (for "no room left here").
//
// Returns one of:
//   { ok: true,  u_position, slot_position }
//   { ok: false, reason: 'incompatible' }  — exact row has a full-width
//     device, or fractional siblings of a *different* width — caller
//     should fall back to the generic free-row search, same as dropping a
//     full-width device onto any other occupied row already behaves.
//   { ok: false, reason: 'full', error }   — exact row has compatible
//     siblings but every column is already taken.
export function resolveFractionalPlacement({ slots, rackId, face, uPosition, slotWidth, excludeSlotId, deviceLabel }) {
  const width = normalizeSlotWidth(slotWidth);
  const columns = SLOT_WIDTH_COLUMNS[width];

  const occupantsHere = slots.filter((s) => {
    if (s.rack_id !== rackId) return false;
    if (s.item_type === 'vertical-pdu') return false;
    if (excludeSlotId != null && String(s.id) === String(excludeSlotId)) return false;
    const mountedFace = s.mounted_face || s.front_back || 'front';
    if (face !== 'both' && mountedFace !== 'both' && mountedFace !== face) return false;
    const top = s.u_position + s.u_size - 1;
    return uPosition >= s.u_position && uPosition <= top;
  });

  if (occupantsHere.length === 0) {
    return { ok: true, u_position: uPosition, slot_position: 0 };
  }

  const existingWidth = normalizeSlotWidth(occupantsHere[0].slot_width);
  const allSameWidth = occupantsHere.every((s) => normalizeSlotWidth(s.slot_width) === existingWidth);
  if (existingWidth !== width || !allSameWidth) {
    return { ok: false, reason: 'incompatible' };
  }

  const takenPositions = new Set(occupantsHere.map((s) => Number(s.slot_position) || 0));
  for (let pos = 0; pos < columns; pos++) {
    if (!takenPositions.has(pos)) return { ok: true, u_position: uPosition, slot_position: pos };
  }
  return {
    ok: false,
    reason: 'full',
    error: `This U slot is full — no more ${deviceLabel || 'devices'} can be added here`,
  };
}

// Builds the set of U rows occupied on a given face of a rack, for a quick
// client-side collision heuristic. This intentionally ignores half-width
// nuances (two half-width devices can share U rows on opposite halves) —
// the backend remains the authoritative collision check; this is only used
// to pick which anchor direction to try first. Vertical PDUs are 0U
// floating elements alongside the frame, not real U-grid occupants — they
// still carry a u_position/u_size in storage, but that range must never
// count as occupying real rows (matching the backend's collision check).
export function buildOccupiedSet(slots, rackId, face, excludeSlotId) {
  const occupied = new Set();
  for (const s of slots) {
    if (s.rack_id !== rackId) continue;
    if (s.item_type === 'vertical-pdu') continue;
    if (excludeSlotId != null && String(s.id) === String(excludeSlotId)) continue;
    const mountedFace = s.mounted_face || s.front_back || 'front';
    const matches = face === 'both' || mountedFace === 'both' || mountedFace === face;
    if (!matches) continue;
    const top = s.u_position + s.u_size - 1;
    for (let u = s.u_position; u <= top; u++) occupied.add(u);
  }
  return occupied;
}

// Counts how many distinct U rows are occupied by something on either face
// of a rack (a U is "used" if anything sits on it at all). Vertical PDUs are
// 0U floating elements alongside the frame, not real U-grid occupants, so
// they're excluded — matching the backend's resize-fit check.
export function countUsedU(slots, rackId) {
  const used = new Set();
  for (const s of slots) {
    if (s.rack_id !== rackId) continue;
    if (s.item_type === 'vertical-pdu') continue;
    const top = s.u_position + s.u_size - 1;
    for (let u = s.u_position; u <= top; u++) used.add(u);
  }
  return used.size;
}

// Assigns each vertical PDU in a rack to a side rail channel (left of the
// Front column, or right of the Rear column / right of Front when Rear
// isn't showing — a presentation concern handled separately by whatever
// turns this into pixel coordinates, see verticalPduLayout's pduLeftPx)
// and a stacking slot within that channel (0 = top, 1 = bottom — a channel
// holds at most 2; callers are expected to reject adding a 3rd, see the
// rack-slots POST route).
//
// `mount_side` and `vertical_pdu_position` are stored columns and are
// authoritative when present. PDUs created before those were persisted
// (side used to be computed live by creation order, position was never
// stored at all) fall back to the same alternating-by-creation-order
// behavior this function always had, so old data keeps landing somewhere
// sane instead of breaking or all collapsing onto one side.
//
// Returns Map<pduId, { side: 'left'|'right', stack: number }>.
export function computeVerticalPduPositions(verticalPdus) {
  const sorted = [...verticalPdus].sort((a, b) => a.id - b.id);
  const buckets = { left: [], right: [] };
  const unassigned = [];

  for (const pdu of sorted) {
    if (pdu.mount_side === 'left' || pdu.mount_side === 'right') {
      buckets[pdu.mount_side].push(pdu);
    } else {
      unassigned.push(pdu);
    }
  }
  // Legacy fallback: a PDU with no stored side at all goes onto whichever
  // side currently has fewer (left-preferred on a tie) — the same
  // alternating behavior this function always had before sides were stored.
  for (const pdu of unassigned) {
    const side = buckets.left.length <= buckets.right.length ? 'left' : 'right';
    buckets[side].push(pdu);
  }

  const positions = new Map();
  for (const side of ['left', 'right']) {
    // Stored vertical_pdu_position wins when present; PDUs without one
    // (legacy data, or a 3rd+ PDU beyond the normal 2-per-side cap) sort
    // after positioned ones, by creation order.
    const ordered = [...buckets[side]].sort((a, b) => {
      const pa = a.vertical_pdu_position === 0 || a.vertical_pdu_position === 1 ? a.vertical_pdu_position : 2;
      const pb = b.vertical_pdu_position === 0 || b.vertical_pdu_position === 1 ? b.vertical_pdu_position : 2;
      if (pa !== pb) return pa - pb;
      return a.id - b.id;
    });
    ordered.forEach((pdu, index) => positions.set(pdu.id, { side, stack: index }));
  }

  return positions;
}

// Resolves where a vertical PDU being dropped onto (or moved to) a side
// rail channel should land: the next open stacking slot (0 or 1) on that
// side, or a rejection if the channel already holds 2. `excludeSlotId`
// skips the PDU's own current row when moving it (so it doesn't count
// against itself).
export function resolveVerticalPduSide({ verticalPdus, side, excludeSlotId }) {
  const others = verticalPdus.filter((p) => excludeSlotId == null || String(p.id) !== String(excludeSlotId));
  const positions = computeVerticalPduPositions(others);
  const takenStacks = new Set();
  for (const p of others) {
    const assigned = positions.get(p.id);
    if (assigned?.side === side) takenStacks.add(assigned.stack);
  }
  if (takenStacks.size >= 2) {
    return { ok: false, error: 'This rail channel is full' };
  }
  const stack = takenStacks.has(0) ? 1 : 0;
  return { ok: true, side, vertical_pdu_position: stack };
}
