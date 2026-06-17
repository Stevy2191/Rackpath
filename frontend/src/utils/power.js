import { resolveRenderType } from '../components/racks/deviceRenderConfig';

const PASSIVE_RENDER_TYPES = new Set(['blank', 'patch-panel', 'cable-manager']);

// Devices with no power cord — nothing to plug in or be plugged into.
export function isPassiveItem(slot) {
  return PASSIVE_RENDER_TYPES.has(resolveRenderType(slot));
}

// PDU/UPS: provides outlets that other devices can be plugged into.
export function isPowerDevice(slot) {
  const type = resolveRenderType(slot);
  return type === 'ups' || type === 'pdu';
}

// UPS specifically — the only device type that can host vertical PDUs.
export function isUps(slot) {
  return resolveRenderType(slot) === 'ups';
}

export function getOutletCount(slot) {
  return Number(slot?.outlet_count) || 0;
}

export function getPowerLabel(slot) {
  return slot?.item_label || slot?.hostname || slot?.ip || 'Device';
}

// All outlet-providing slots in the rack except the one being edited, with
// their occupancy resolved. Shape: [{ slot, outlets: [{ n, occupant }] }]
export function listPowerSources(rackSlots, excludeSlotId) {
  return rackSlots
    .filter((s) => isPowerDevice(s) && s.id !== excludeSlotId && getOutletCount(s) > 0)
    .map((s) => ({
      slot: s,
      outlets: Array.from({ length: getOutletCount(s) }, (_, i) => {
        const n = i + 1;
        const occupant = rackSlots.find((c) => c.power_source_slot_id === s.id && c.power_source_outlet === n);
        return { n, occupant: occupant || null };
      }),
    }));
}

// Flat <option>-ready list for the "Plugged Into" dropdown.
export function buildOutletOptions(rackSlots, excludeSlotId, currentSlotId) {
  const options = [];
  for (const { slot, outlets } of listPowerSources(rackSlots, excludeSlotId)) {
    for (const { n, occupant } of outlets) {
      const occupiedByOther = occupant && occupant.id !== currentSlotId;
      options.push({
        sourceSlotId: slot.id,
        outlet: n,
        label: `${getPowerLabel(slot)} — Outlet ${n}`,
        disabled: Boolean(occupiedByOther),
      });
    }
  }
  return options;
}

// How many of a PDU/UPS's outlets currently have something plugged in.
export function countOccupiedOutlets(slot, rackSlots) {
  let count = 0;
  for (let n = 1; n <= getOutletCount(slot); n++) {
    if (rackSlots.some((s) => s.power_source_slot_id === slot.id && s.power_source_outlet === n)) count++;
  }
  return count;
}

// Vertical PDUs floating alongside the rack frame that belong to this UPS
// (i.e. plugged into one of its outlets).
export function verticalPdusForUps(rackSlots, upsSlotId) {
  return rackSlots.filter((s) => s.item_type === 'vertical-pdu' && s.power_source_slot_id === upsSlotId);
}

// First free outlet number on a power source, or null if it's full.
export function firstFreeOutlet(sourceSlot, rackSlots) {
  for (let n = 1; n <= getOutletCount(sourceSlot); n++) {
    const taken = rackSlots.some((s) => s.power_source_slot_id === sourceSlot.id && s.power_source_outlet === n);
    if (!taken) return n;
  }
  return null;
}
