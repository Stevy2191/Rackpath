import { resolveRenderType } from '../components/racks/deviceRenderConfig';

const PASSIVE_RENDER_TYPES = new Set([
  'blank', 'patch-panel', 'patch-panel-copper', 'patch-panel-fiber',
  'cable-manager', 'keystone', 'shelf', 'drawer',
]);

// Devices with no power cord — nothing to plug in or be plugged into.
export function isPassiveItem(slot) {
  return PASSIVE_RENDER_TYPES.has(resolveRenderType(slot));
}

// PDU/UPS: provides outlets that other devices can be plugged into.
export function isPowerDevice(slot) {
  const type = resolveRenderType(slot);
  return type === 'ups' || type === 'pdu' || type === 'pdu-vertical';
}

// UPS specifically — the only device type that can host vertical PDUs.
export function isUps(slot) {
  return resolveRenderType(slot) === 'ups';
}

// A device's outlets are modeled as groups of same-typed outlets, e.g.
// [{type:'NEMA 5-15R', count:6}, {type:'C19', count:2}] for a mixed unit,
// rather than one flat count + type. Outlet *numbers* (power_source_outlet)
// stay a single continuous integer across all groups in order — group 1's
// outlets are 1..count1, group 2's are count1+1..count1+count2, etc. —
// display labels just re-derive "Type — Outlet i within its group" from
// that, so no schema change was needed for the numbering itself.
export function getOutletGroups(slot) {
  return Array.isArray(slot?.outlet_groups) ? slot.outlet_groups : [];
}

export function getOutletCount(slot) {
  return getOutletGroups(slot).reduce((sum, g) => sum + (Number(g?.count) || 0), 0);
}

// Flattens a device's outlet groups into one ordered list with both the
// global outlet number (used for power_source_outlet) and the type/local
// index within its group (used for display, e.g. "C19 — Outlet 2").
export function flattenOutlets(slot) {
  const result = [];
  let n = 0;
  for (const group of getOutletGroups(slot)) {
    const count = Number(group?.count) || 0;
    for (let i = 1; i <= count; i++) {
      n++;
      result.push({ n, type: group.type || 'Outlet', indexInGroup: i });
    }
  }
  return result;
}

export function getPowerLabel(slot) {
  return slot?.item_label || slot?.hostname || slot?.ip || 'Device';
}

// All outlet-providing slots in the rack except the one being edited, with
// their occupancy resolved. Shape: [{ slot, outlets: [{ n, type, indexInGroup, occupant }] }]
export function listPowerSources(rackSlots, excludeSlotId) {
  return rackSlots
    .filter((s) => isPowerDevice(s) && s.id !== excludeSlotId && getOutletCount(s) > 0)
    .map((s) => ({
      slot: s,
      outlets: flattenOutlets(s).map(({ n, type, indexInGroup }) => {
        const occupant = rackSlots.find((c) => c.power_source_slot_id === s.id && c.power_source_outlet === n);
        return { n, type, indexInGroup, occupant: occupant || null };
      }),
    }));
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
