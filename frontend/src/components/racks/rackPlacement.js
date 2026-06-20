// Shared helper for placing a multi-U device relative to the rack row it was
// dropped on. Drops are normally anchored so the drop row becomes the
// device's topmost U, but that anchoring can push the device past U1 (the
// bottom of the rack) or past the rack's top. Clamping here lets the device
// slide the other direction so it still lands at the drop point whenever the
// rack has enough total U's, regardless of which edge the drop is near.
export function clampUPosition(dropU, uSize, rackUHeight) {
  const desired = dropU - uSize + 1;
  return Math.max(1, Math.min(rackUHeight - uSize + 1, desired));
}
