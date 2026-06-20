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
export const OUTLET_TYPES = ['C13', 'C14', 'C19', 'NEMA 5-15R', 'NEMA 5-20R'];
export const INPUT_VOLTAGES = ['120V', '208V', '240V'];

// kind: 'select' (options + allowCustom) | 'number'
export const DEVICE_FIELD_SCHEMAS = {
  'blade-chassis': [
    { key: 'bay_count', label: 'Bay Count', kind: 'number', min: 1, max: 64, default: 8 },
  ],
  switch: [
    { key: 'port_count', label: 'Port Count', kind: 'select', options: PORT_COUNT_PRESETS, allowCustom: true, default: 24 },
  ],
  ups: [
    { key: 'outlet_count', label: 'Outlet Count', kind: 'number', min: 1, max: 24, default: 6 },
    { key: 'outlet_type', label: 'Outlet Type', kind: 'select', options: OUTLET_TYPES, default: 'NEMA 5-15R' },
    { key: 'input_voltage', label: 'Input Voltage', kind: 'select', options: INPUT_VOLTAGES, default: '120V' },
    { key: 'capacity_va', label: 'Capacity (VA)', kind: 'number', min: 100, max: 20000, step: 100, default: 1500 },
  ],
  pdu: [
    { key: 'outlet_count', label: 'Outlet Count', kind: 'number', min: 1, max: 48, default: 8 },
    { key: 'outlet_type', label: 'Outlet Type', kind: 'select', options: OUTLET_TYPES, default: 'C13' },
  ],
  'pdu-vertical': [
    { key: 'outlet_count', label: 'Outlet Count', kind: 'number', min: 1, max: 48, default: 8 },
    { key: 'outlet_type', label: 'Outlet Type', kind: 'select', options: OUTLET_TYPES, default: 'C13' },
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
      outlet_count: entry.outlet_count ?? null,
      outlet_type: entry.outlet_type ?? null,
      input_voltage: entry.input_voltage ?? null,
      capacity_va: entry.capacity_va ?? null,
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
    outlet_count: entry.outletCount ?? null,
    outlet_type: entry.outletType ?? null,
    input_voltage: entry.inputVoltage ?? null,
    capacity_va: entry.capacityVa ?? null,
    port_count: entry.portCount ?? null,
    bay_count: entry.bayCount ?? null,
  };
}
