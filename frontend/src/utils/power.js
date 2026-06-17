import { resolveRenderType } from '../components/racks/deviceRenderConfig';

const PASSIVE_RENDER_TYPES = new Set(['blank', 'patch-panel', 'cable-manager']);

// Devices with no power cord — nothing to draw, plug in, or power from.
export function isPassiveItem(slot) {
  return PASSIVE_RENDER_TYPES.has(resolveRenderType(slot));
}

// PDU/UPS: provides outlets and can be a power source for other devices.
export function isPowerDevice(slot) {
  const type = resolveRenderType(slot);
  return type === 'ups' || type === 'pdu';
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

// Flat <option>-ready list for the Power Source / Upstream Power Source dropdown.
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

// Total connected load (W) on a PDU/UPS, recursively following any
// downstream PDU/UPS chained into one of its outlets. hasUnknown is true if
// any connected device (at any depth) has no power_draw_w set.
export function computeLoad(sourceSlot, rackSlots) {
  function recurse(slot, visited) {
    if (visited.has(slot.id)) return { total: 0, hasUnknown: false };
    visited.add(slot.id);
    let total = 0;
    let hasUnknown = false;
    for (const child of rackSlots.filter((s) => s.power_source_slot_id === slot.id)) {
      if (isPowerDevice(child) && getOutletCount(child) > 0) {
        const sub = recurse(child, visited);
        total += sub.total;
        if (sub.hasUnknown) hasUnknown = true;
      } else if (child.power_draw_w != null && child.power_draw_w !== '') {
        total += Number(child.power_draw_w);
      } else {
        hasUnknown = true;
      }
    }
    return { total, hasUnknown };
  }
  return recurse(sourceSlot, new Set());
}
