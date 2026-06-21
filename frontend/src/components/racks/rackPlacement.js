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

// Builds the set of U rows occupied on a given face of a rack, for a quick
// client-side collision heuristic. This intentionally ignores half-width
// nuances (two half-width devices can share U rows on opposite halves) —
// the backend remains the authoritative collision check; this is only used
// to pick which anchor direction to try first.
export function buildOccupiedSet(slots, rackId, face, excludeSlotId) {
  const occupied = new Set();
  for (const s of slots) {
    if (s.rack_id !== rackId) continue;
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

// Assigns each vertical PDU in a rack to one of three floating positions —
// left of the Front column, the middle gap between Front and Rear, or right
// of the Rear column — by creation order (lowest id first). Only one PDU
// ever lands in the middle: it's the actual physical centerline of the
// rack, just wide enough for one strip, so every PDU after the 2nd
// alternates further out on the left/right instead of trying to share it.
//
// `hasMiddle` should be false when Rear is hidden — there's no gap to
// float a middle PDU in once Rear's column disappears and Front expands
// to fill the space, so whichever PDU would've been 2nd (middle) instead
// stacks on the left, same as any other left-side PDU.
//
// Returns Map<pduId, { side: 'left'|'middle'|'right', stack: number }>,
// where `stack` is how many other PDUs on that same side sit between this
// one and the frame (0 = closest).
export function computeVerticalPduPositions(verticalPdus, { hasMiddle = true } = {}) {
  const sorted = [...verticalPdus].sort((a, b) => a.id - b.id);
  const positions = new Map();
  let leftCount = 0;
  let rightCount = 0;

  sorted.forEach((pdu, index) => {
    let side;
    if (index === 0) side = 'left';
    else if (index === 1) side = hasMiddle ? 'middle' : 'left';
    else if (index === 2) side = 'right';
    // From the 4th PDU on, alternate left/right regardless of hasMiddle —
    // this matches the with-middle scheme exactly (index 3 -> left, 4 ->
    // right, ...) since index is odd/even in the same pattern either way.
    else side = index % 2 === 1 ? 'left' : 'right';

    if (side === 'middle') {
      positions.set(pdu.id, { side, stack: 0 });
    } else if (side === 'left') {
      positions.set(pdu.id, { side, stack: leftCount });
      leftCount += 1;
    } else {
      positions.set(pdu.id, { side, stack: rightCount });
      rightCount += 1;
    }
  });

  return positions;
}
