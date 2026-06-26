import { resolveRenderType } from '../components/racks/deviceRenderConfig';
import { computeVerticalPduPositions } from '../components/racks/rackPlacement';

const PASSIVE_RENDER_TYPES = new Set([
  'blank', 'patch-panel', 'patch-panel-copper', 'patch-panel-fiber',
  'cable-manager', 'keystone', 'shelf', 'drawer',
]);

// Devices with no power cord — nothing to plug in or be plugged into.
export function isPassiveItem(slot) {
  return PASSIVE_RENDER_TYPES.has(resolveRenderType(slot));
}

// PDU/UPS/ATS/Transformer: provides outlets that other devices can be plugged into.
export function isPowerDevice(slot) {
  const type = resolveRenderType(slot);
  return type === 'ups' || type === 'pdu' || type === 'pdu-vertical' || type === 'ats' || type === 'transformer';
}

// UPS specifically — the only device type that can host vertical PDUs.
export function isUps(slot) {
  return resolveRenderType(slot) === 'ups';
}

// ATS (Automatic Transfer Switch) — draws from two independent upstream
// sources (Input A/B, reusing the same PSU1/PSU2 columns any consumer
// device's two power cords use) and feeds exactly one downstream device
// from its single outlet, unlike a PDU/UPS's bank of several.
export function isAts(slot) {
  return resolveRenderType(slot) === 'ats';
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
  const groups = getOutletGroups(slot);
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    const count = Number(group?.count) || 0;
    for (let i = 1; i <= count; i++) {
      n++;
      result.push({ n, groupIndex: gi + 1, type: group.type || 'Outlet', indexInGroup: i });
    }
  }
  return result;
}

export function getPowerLabel(slot) {
  return slot?.item_label || slot?.hostname || slot?.ip || 'Device';
}

// Same as getPowerLabel, but disambiguates a vertical PDU with "(Left)"/
// "(Right)" — needed once a power source can be picked from a list mixing
// every rack's PDUs together (see listPowerSources), where "two PDUs both
// just called 'PDU'" would otherwise be indistinguishable. `allSlots` only
// needs to contain this PDU's own rack's vertical PDUs for the position to
// come out right — passing the full project-wide list is fine too, since
// computeVerticalPduPositions only looks at items it's given.
export function getPowerSourceLabel(slot, allSlots) {
  const label = getPowerLabel(slot);
  if (slot?.item_type !== 'vertical-pdu') return label;
  const sideBySlot = computeVerticalPduPositions(
    allSlots.filter((s) => s.item_type === 'vertical-pdu' && s.rack_id === slot.rack_id)
  );
  const side = sideBySlot.get(slot.id)?.side;
  return side ? `${label} (${side === 'left' ? 'Left' : 'Right'})` : label;
}

// Does `candidate`'s PSU1 or PSU2 claim outlet `n` on `sourceSlotId`? Every
// occupancy check (the outlet list on a PDU/UPS, picking a free outlet,
// counting how many are in use) has to check both PSU columns, since
// either one of a device's two independent power cords could be the one
// plugged into this particular outlet.
function claims(candidate, sourceSlotId, n) {
  return (candidate.power_source_slot_id === sourceSlotId && candidate.power_source_outlet === n)
      || (candidate.psu2_source_slot_id === sourceSlotId && candidate.psu2_source_outlet === n);
}

// Finds whichever device (and which of its two PSUs) claims outlet `n` on
// `sourceSlotId`, across the whole project — a PDU/UPS's outlets are
// occupied by whichever device claims them, regardless of which rack that
// device physically sits in. Returns { slot, psu: 'psu1'|'psu2' } or null.
export function findOccupant(allSlots, sourceSlotId, n) {
  for (const s of allSlots) {
    if (s.power_source_slot_id === sourceSlotId && s.power_source_outlet === n) return { slot: s, psu: 'psu1' };
    if (s.psu2_source_slot_id === sourceSlotId && s.psu2_source_outlet === n) return { slot: s, psu: 'psu2' };
  }
  return null;
}

// Every outlet-providing slot in the *project* (any rack) except the one
// being edited, with occupancy resolved against every device's PSU1 *and*
// PSU2 — a device's two power cords can each go to a PDU/UPS in any rack,
// so working out whether a given outlet is free has to look project-wide,
// not just within whichever rack the outlet's own PDU/UPS happens to sit
// in. Shape: [{ slot, rackId, outlets: [{ n, type, indexInGroup, occupant, occupantPsu }] }]
export function listPowerSources(allSlots, excludeSlotId) {
  return allSlots
    .filter((s) => isPowerDevice(s) && s.id !== excludeSlotId && getOutletCount(s) > 0)
    .map((s) => ({
      slot: s,
      rackId: s.rack_id,
      outlets: flattenOutlets(s).map(({ n, groupIndex, type, indexInGroup }) => {
        const found = findOccupant(allSlots, s.id, n);
        return { n, groupIndex, type, indexInGroup, occupant: found?.slot || null, occupantPsu: found?.psu || null };
      }),
    }));
}

// Groups listPowerSources' flat list by rack, in rack display order, for
// the "Wall (Direct)" / "Rack A — PDU Left" / "Rack B — UPS" tiered
// selector. Returns [{ rackId, rackName, sources: [...] }].
export function groupPowerSourcesByRack(allSlots, racks, excludeSlotId) {
  const sources = listPowerSources(allSlots, excludeSlotId);
  const byRack = new Map();
  for (const rack of racks) byRack.set(rack.id, { rackId: rack.id, rackName: rack.name, sources: [] });
  for (const entry of sources) {
    if (!byRack.has(entry.rackId)) byRack.set(entry.rackId, { rackId: entry.rackId, rackName: `Rack ${entry.rackId}`, sources: [] });
    byRack.get(entry.rackId).sources.push(entry);
  }
  return [...byRack.values()].filter((g) => g.sources.length > 0);
}

// How many of a PDU/UPS's outlets currently have something plugged in,
// project-wide, counting either PSU.
export function countOccupiedOutlets(slot, allSlots) {
  let count = 0;
  for (let n = 1; n <= getOutletCount(slot); n++) {
    if (allSlots.some((s) => claims(s, slot.id, n))) count++;
  }
  return count;
}

// Vertical PDUs floating alongside the rack frame that belong to this UPS
// (i.e. plugged into one of its outlets via PSU1 — a vertical PDU only
// ever has the one connection, to its owning UPS, never a PSU2).
export function verticalPdusForUps(rackSlots, upsSlotId) {
  return rackSlots.filter((s) => s.item_type === 'vertical-pdu' && s.power_source_slot_id === upsSlotId);
}

// First free outlet number on a power source, project-wide, or null if
// every outlet already has something on PSU1 or PSU2.
export function firstFreeOutlet(sourceSlot, allSlots) {
  for (let n = 1; n <= getOutletCount(sourceSlot); n++) {
    if (!allSlots.some((s) => claims(s, sourceSlot.id, n))) return n;
  }
  return null;
}
