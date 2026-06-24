// Generic device catalog for the Rack Builder. Entries describe device
// *types*, not vendor models — every type is fully configurable (height,
// port/bay counts, outlet specs, etc.) via the quick-config step shown when
// it's placed, and again afterwards in the device properties panel.
// Fields: id, name, category, renderType, uSize, mountedFace, halfDepth, slotWidth.
// `mountedFace` matches the DB column: 'front' | 'rear' | 'both'.
// `slotWidth` matches the DB column: 'full' | 'half-width' | 'third' — a
// non-'full' device can share a U row side by side with others of the SAME
// slotWidth (2 for half-width, 3 for third); `halfWidth` is kept in sync
// (true iff slotWidth === 'half-width') purely for backwards compat with
// code/data that only knows the older boolean (e.g. saving a catalog
// placement to the user's own custom catalog, which still only models
// half-width, not thirds — see deviceFieldSchemas.js).
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
  { id: 'COMPUTING',            label: 'Computing' },
  { id: 'NETWORKING',           label: 'Networking' },
  { id: 'POWER',                label: 'Power' },
  { id: 'STORAGE',               label: 'Storage' },
  { id: 'SECURITY',             label: 'Security' },
  { id: 'PATCHING & CABLING',   label: 'Patching & Cabling' },
  { id: 'KVM & MANAGEMENT',     label: 'KVM & Management' },
  { id: 'AV & MEDIA',           label: 'AV & Media' },
  { id: 'GENERAL',              label: 'General' },
];

function e(id, name, category, renderType, uSize, opts = {}) {
  const slotWidth = opts.slotWidth || 'full';
  return {
    id, name, category, renderType, uSize,
    halfDepth: opts.halfDepth || false,
    slotWidth,
    halfWidth: opts.halfWidth || slotWidth === 'half-width',
    mountedFace: opts.mountedFace || 'front',
    outletCount:  opts.outletCount,
    outletType:   opts.outletType,
    inputVoltage: opts.inputVoltage,
    capacityVa:   opts.capacityVa,
    portCount:    opts.portCount,
    bayCount:     opts.bayCount,
    floating:     opts.floating || false,
    deviceType:   opts.deviceType || null,
    color:        opts.color || null,
  };
}

export const RACK_CATALOG = [
  // ─── SERVERS ────────────────────────────────────────────────────────────────
  e('server',        'Server',         'SERVERS', 'server', 1),
  e('blade-chassis',  'Blade Chassis',  'SERVERS', 'blade-chassis', 4, { bayCount: 8 }),

  // ─── COMPUTING ──────────────────────────────────────────────────────────────
  // Mini PC and Regular PC are fractional-width: up to 3 Mini PCs, or 2
  // Regular PCs, can share a single U slot side by side (slotWidth below).
  // Rack Mount PC is a standard full-width 1U device, nothing special.
  e('mini-pc', 'Mini PC', 'COMPUTING', 'mini-pc', 1, {
    slotWidth: 'third', color: '#6B7280',
  }),
  e('regular-pc', 'Regular PC', 'COMPUTING', 'regular-pc', 1, {
    slotWidth: 'half-width', color: '#6B7280',
  }),
  e('rack-mount-pc', 'Rack Mount PC', 'COMPUTING', 'rack-mount-pc', 1, {
    color: '#6B7280',
  }),

  // ─── NETWORKING ─────────────────────────────────────────────────────────────
  e('switch',              'Switch',               'NETWORKING', 'switch', 1, { portCount: 24 }),
  e('router-firewall',      'Router / Firewall',    'NETWORKING', 'firewall', 1),
  e('wireless-controller', 'Wireless Controller',   'NETWORKING', 'wireless-controller', 1),
  e('load-balancer',       'Load Balancer',         'NETWORKING', 'load-balancer', 1),

  // ─── POWER ──────────────────────────────────────────────────────────────────
  e('ups', 'UPS', 'POWER', 'ups', 2, { outletCount: 6, outletType: 'NEMA 5-15R', inputVoltage: '120V', capacityVa: 1500, deviceType: 'ups' }),
  e('pdu-horizontal', 'PDU - Horizontal', 'POWER', 'pdu', 1, {
    halfDepth: true, outletCount: 8, outletType: 'IEC C13',
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
  // Step-down transformer: converts 208V/240V feed to 120V and re-distributes
  // it to downstream devices via its own bank of outlets.
  e('stepdown-transformer', 'Stepdown Transformer', 'POWER', 'transformer', 2, {
    outletCount: 8, outletType: 'NEMA 5-15R', inputVoltage: '208V',
  }),
  // Extended Battery Module: attaches to a compatible UPS to extend its
  // runtime; occupies its own U slots but provides no outlets of its own.
  e('ebm', 'Extended Battery Module', 'POWER', 'ebm', 2, { capacityVa: 1500, deviceType: 'ebm' }),

  // ─── STORAGE ────────────────────────────────────────────────────────────────
  e('nas-storage-array', 'NAS / Storage Array', 'STORAGE', 'storage', 2, { bayCount: 12 }),
  e('tape-library',      'Tape Library',        'STORAGE', 'tape-library', 4),
  e('san-switch',        'SAN Switch',          'STORAGE', 'san-switch', 1),

  // ─── SECURITY ───────────────────────────────────────────────────────────────
  e('nvr', 'NVR', 'SECURITY', 'nvr', 1, { color: '#1F2937' }),

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
