// Per-device-type configurable field schemas, used by QuickConfigModal (at
// placement time) and DevicePropertiesPanel (after placement) so both stay
// in sync about which extra fields a given renderType exposes.
//
// Label, Height (U), Color, Width, and Depth apply to every device type and
// are handled directly by the callers — this file only describes the
// *extra* fields specific to a renderType.

export const COLOR_SWATCHES = [
  '#4adede', '#34d976', '#f59e0b', '#ef4444',
  '#a78bfa', '#fb923c', '#38bdf8', '#f472b6',
  null, // null = clear
];

export const PORT_COUNT_PRESETS = [8, 12, 24, 48, 96];
export const PATCH_PORT_PRESETS = [12, 24, 48];
// "Other" isn't listed here — TypeSelect always appends its own "Other…"
// option (which reveals a free-text input), so including it in the preset
// list too would show it twice.
export const OUTLET_TYPES = ['NEMA 5-15R', 'NEMA 5-20R', 'NEMA L5-30R', 'NEMA L6-20R', 'NEMA L6-30R', 'IEC C13', 'IEC C19', 'IEC C7'];
export const INPUT_PLUG_TYPES = ['NEMA 5-15P', 'NEMA 5-20P', 'NEMA L5-30P', 'NEMA L6-20P', 'NEMA L6-30P', 'IEC C14', 'IEC C20'];
export const INPUT_VOLTAGES = ['120V', '208V', '240V'];
export const CAPACITY_UNITS = ['A', 'W'];

// kind: 'select' (options + allowCustom) | 'number'
// UPS/PDU/PDU-vertical have no entries here — their power fields (input
// plug, voltage, capacity, outlet groups) are bespoke in the properties
// panel's POWER tab rather than the generic Configuration section.
export const DEVICE_FIELD_SCHEMAS = {
  'blade-chassis': [
    { key: 'bay_count', label: 'Bay Count', kind: 'number', min: 1, max: 64, default: 8 },
  ],
  switch: [
    { key: 'port_count', label: 'Port Count', kind: 'select', options: PORT_COUNT_PRESETS, allowCustom: true, default: 24 },
  ],
  storage: [
    { key: 'bay_count', label: 'Bay Count', kind: 'number', min: 1, max: 60, default: 12 },
  ],
  'patch-panel-copper': [
    { key: 'port_count', label: 'Port Count', kind: 'select', options: PATCH_PORT_PRESETS, allowCustom: true, default: 24 },
  ],
  'patch-panel-fiber': [
    { key: 'port_count', label: 'Port Count', kind: 'select', options: PATCH_PORT_PRESETS, allowCustom: true, default: 24 },
  ],
  kvm: [
    { key: 'port_count', label: 'Port Count', kind: 'number', min: 1, max: 64, default: 8 },
  ],
};

export function getFieldSchema(renderType) {
  return DEVICE_FIELD_SCHEMAS[renderType] || [];
}

// A single outlet count + type (the old model, and still how generic
// catalog entries describe their default outlets) folds into a one-group
// outlet_groups array.
function singleOutletGroup(count, type) {
  return count ? [{ type: type || 'Other', count: Number(count) }] : [];
}

// Normalizes a generic catalog entry (camelCase, from rackCatalog.js) or a
// saved user catalog entry (snake_case, from the user_catalog_entries API)
// into one consistent snake_case shape for QuickConfigModal and catalog
// card badges.
export function normalizeCatalogEntry(entry, source) {
  if (source === 'custom') {
    return {
      label: entry.name,
      render_type: entry.render_type,
      u_size: entry.u_size,
      color: entry.color || null,
      half_width: !!entry.half_width,
      half_depth: !!entry.half_depth,
      mounted_face: entry.mounted_face || 'front',
      outlet_groups: Array.isArray(entry.outlet_groups) ? entry.outlet_groups : [],
      input_voltage: entry.input_voltage ?? null,
      input_plug_type: entry.input_plug_type ?? null,
      capacity_va: entry.capacity_va ?? null,
      capacity_value: entry.capacity_value ?? null,
      capacity_unit: entry.capacity_unit ?? null,
      port_count: entry.port_count ?? null,
      bay_count: entry.bay_count ?? null,
    };
  }
  return {
    label: entry.name,
    render_type: entry.renderType,
    u_size: entry.uSize,
    color: null,
    half_width: !!entry.halfWidth,
    half_depth: !!entry.halfDepth,
    mounted_face: entry.mountedFace || 'front',
    outlet_groups: singleOutletGroup(entry.outletCount, entry.outletType),
    input_voltage: entry.inputVoltage ?? null,
    input_plug_type: null,
    capacity_va: entry.capacityVa ?? null,
    capacity_value: null,
    capacity_unit: null,
    port_count: entry.portCount ?? null,
    bay_count: entry.bayCount ?? null,
  };
}
