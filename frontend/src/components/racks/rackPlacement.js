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

// Assigns each vertical PDU in a rack to a floating position — left of the
// Front column, or right of the Rear column (or right of Front when Rear
// isn't showing/doesn't exist — a presentation concern handled separately
// by whatever turns this into pixel coordinates, see verticalPduLayout's
// pduLeftPx) — by creation order (lowest id first): 1st PDU goes left, 2nd
// goes right. Real dual-PSU rack setups mount exactly one PDU per side, so
// callers are expected to reject adding a 3rd (see the rack-slots POST
// route) — this function itself doesn't enforce that, it just keeps
// alternating sides if it's ever called with more than 2, so pre-existing
// data from before that limit existed still renders somewhere sane
// instead of breaking.
//
// This used to also have a 3rd 'middle' position (the actual physical
// centerline, for the 2nd PDU specifically) — removed because a real
// vertical PDU only ever mounts left/right of the frame, never literally
// between Front and Rear. Any PDU previously assigned 'middle' (always
// the 2nd-created one in its rack) now lands on 'right' instead, exactly
// matching "Left if available, Right if not": the 1st PDU always already
// holds 'left' by the time there's a 2nd one. No data migration needed,
// since this position was always computed live, never stored.
//
// Returns Map<pduId, { side: 'left'|'right', stack: number }>, where
// `stack` is how many other PDUs on that same side sit between this one
// and the frame (0 = closest).
export function computeVerticalPduPositions(verticalPdus) {
  const sorted = [...verticalPdus].sort((a, b) => a.id - b.id);
  const positions = new Map();
  let leftCount = 0;
  let rightCount = 0;

  sorted.forEach((pdu, index) => {
    const side = index % 2 === 0 ? 'left' : 'right';
    if (side === 'left') {
      positions.set(pdu.id, { side, stack: leftCount });
      leftCount += 1;
    } else {
      positions.set(pdu.id, { side, stack: rightCount });
      rightCount += 1;
    }
  });

  return positions;
}
