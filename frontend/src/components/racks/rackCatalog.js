// Generic device catalog for the Rack Builder. Entries describe device
// *types*, not vendor models — every type is fully configurable (height,
// port/bay counts, outlet specs, etc.) via the quick-config step shown when
// it's placed, and again afterwards in the device properties panel.
// Fields: id, name, category, renderType, uSize, mountedFace, halfDepth, halfWidth.
// `mountedFace` matches the DB column: 'front' | 'rear' | 'both'.
// `renderType` keys into deviceRenderConfig.js and deviceFieldSchemas.js.
// `floating` entries (vertical/0U PDUs) aren't placed into U rows directly —
// they're attached to a UPS via the properties panel.
// Power fields (all optional, used for power connection mapping):
//   outletCount  – number of outlets provided (PDU/UPS only)
//   outletType   – outlet receptacle type, e.g. 'C13', 'NEMA 5-15R' (PDU/UPS only)
//   inputVoltage – what the PDU/UPS itself draws from its upstream source (PDU/UPS only)
//   capacityVa   – UPS capacity in VA

// renderTypes that map 1:1 onto a dedicated rack_slots.item_type value;
// everything else is stored as item_type: 'custom-device'.
export const SIMPLE_ITEM_TYPES = ['patch-panel', 'blank', 'cable-manager'];

export const CATALOG_CATEGORIES = [
  { id: 'SERVERS',              label: 'Servers' },
  { id: 'NETWORKING',           label: 'Networking' },
  { id: 'POWER',                label: 'Power' },
  { id: 'STORAGE',               label: 'Storage' },
  { id: 'PATCHING & CABLING',   label: 'Patching & Cabling' },
  { id: 'KVM & MANAGEMENT',     label: 'KVM & Management' },
  { id: 'AV & MEDIA',           label: 'AV & Media' },
  { id: 'GENERAL',              label: 'General' },
];

function e(id, name, category, renderType, uSize, opts = {}) {
  return {
    id, name, category, renderType, uSize,
    halfDepth: opts.halfDepth || false,
    halfWidth: opts.halfWidth || false,
    mountedFace: opts.mountedFace || 'front',
    outletCount:  opts.outletCount,
    outletType:   opts.outletType,
    inputVoltage: opts.inputVoltage,
    capacityVa:   opts.capacityVa,
    portCount:    opts.portCount,
    bayCount:     opts.bayCount,
    floating:     opts.floating || false,
  };
}

export const RACK_CATALOG = [
  // ─── SERVERS ────────────────────────────────────────────────────────────────
  e('server',        'Server',         'SERVERS', 'server', 1),
  e('blade-chassis',  'Blade Chassis',  'SERVERS', 'blade-chassis', 4, { bayCount: 8 }),

  // ─── NETWORKING ─────────────────────────────────────────────────────────────
  e('switch',              'Switch',               'NETWORKING', 'switch', 1, { portCount: 24 }),
  e('router-firewall',      'Router / Firewall',    'NETWORKING', 'firewall', 1),
  e('wireless-controller', 'Wireless Controller',   'NETWORKING', 'wireless-controller', 1),
  e('load-balancer',       'Load Balancer',         'NETWORKING', 'load-balancer', 1),

  // ─── POWER ──────────────────────────────────────────────────────────────────
  e('ups', 'UPS', 'POWER', 'ups', 2, { outletCount: 6, outletType: 'NEMA 5-15R', inputVoltage: '120V', capacityVa: 1500 }),
  e('pdu-horizontal', 'PDU - Horizontal', 'POWER', 'pdu', 1, {
    halfDepth: true, mountedFace: 'rear', outletCount: 8, outletType: 'IEC C13',
  }),
  e('pdu-vertical', 'PDU - Vertical / 0U', 'POWER', 'pdu-vertical', 0, {
    outletCount: 8, outletType: 'IEC C13', floating: true,
  }),
  // Rack-mounted like a normal device (occupies U slots), not a floating
  // 0U strip — single outlet (count: 1) since it only ever feeds one
  // downstream device, unlike a PDU's bank of several.
  e('ats', 'ATS - Automatic Transfer Switch', 'POWER', 'ats', 1, {
    outletCount: 1, outletType: 'NEMA 5-15R',
  }),

  // ─── STORAGE ────────────────────────────────────────────────────────────────
  e('nas-storage-array', 'NAS / Storage Array', 'STORAGE', 'storage', 2, { bayCount: 12 }),
  e('tape-library',      'Tape Library',        'STORAGE', 'tape-library', 4),
  e('san-switch',        'SAN Switch',          'STORAGE', 'san-switch', 1),

  // ─── PATCHING & CABLING ─────────────────────────────────────────────────────
  e('patch-panel-copper', 'Patch Panel - Copper', 'PATCHING & CABLING', 'patch-panel-copper', 1, { portCount: 24 }),
  e('patch-panel-fiber',  'Patch Panel - Fiber',  'PATCHING & CABLING', 'patch-panel-fiber', 1, { halfDepth: true, portCount: 24 }),
  e('cable-management',   'Cable Management',     'PATCHING & CABLING', 'cable-manager', 1),
  e('keystone-panel',     'Keystone Panel',       'PATCHING & CABLING', 'keystone', 1),

  // ─── KVM & MANAGEMENT ───────────────────────────────────────────────────────
  e('kvm-switch',  'KVM Switch',             'KVM & MANAGEMENT', 'kvm', 1, { portCount: 8 }),
  e('console-server', 'Console Server',       'KVM & MANAGEMENT', 'console-server', 1),
  e('oob-management', 'Out-of-Band Management', 'KVM & MANAGEMENT', 'oob', 1),

  // ─── AV & MEDIA ─────────────────────────────────────────────────────────────
  e('amplifier',          'Amplifier',          'AV & MEDIA', 'amplifier', 2),
  e('media-player',       'Media Player',       'AV & MEDIA', 'media-player', 1),
  e('display-controller', 'Display Controller', 'AV & MEDIA', 'display-controller', 1),

  // ─── GENERAL ────────────────────────────────────────────────────────────────
  e('shelf',           'Shelf',           'GENERAL', 'shelf', 1),
  e('blanking-panel',  'Blanking Panel',  'GENERAL', 'blank', 1),
  e('drawer',          'Drawer',          'GENERAL', 'drawer', 1),
  e('custom-device',   'Custom Device',   'GENERAL', 'other', 1),
];

export function groupByCategory(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (!map.has(entry.category)) map.set(entry.category, []);
    map.get(entry.category).push(entry);
  }
  return map;
}

// Find a catalog entry whose name matches a device's model field.
// Tries exact case-insensitive match, then suffix match.
export function findCatalogEntryByModel(model) {
  if (!model) return null;
  const needle = model.trim().toLowerCase();
  return (
    RACK_CATALOG.find((e) => e.name.toLowerCase() === needle) ||
    RACK_CATALOG.find((e) => needle.endsWith(e.name.toLowerCase())) ||
    null
  );
}

// PDU catalog entries for the "Add Vertical PDU" picker — vertical/0U
// models only. PDU - Horizontal is a real U-slot device mounted normally
// on a face; it never floats alongside the frame, so it has no place in
// this list regardless of how the vertical-PDU attach flow itself works.
export function pduCatalogEntries() {
  return RACK_CATALOG.filter((entry) => entry.renderType === 'pdu-vertical');
}
