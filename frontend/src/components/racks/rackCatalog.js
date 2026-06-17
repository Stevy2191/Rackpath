// Static device catalog for the Rack Builder.
// Fields: id, name, vendor, category, uSize, renderType, mountedFace, halfDepth, halfWidth.
// `mountedFace` matches the DB column: 'front' | 'rear' | 'both'.
// `renderType` keys into deviceRenderConfig.js.
// Power fields (all optional, used by the power management feature):
//   powerDrawW   – typical load in watts (any device)
//   outletCount  – number of outlets provided (PDU/UPS only)
//   outletType   – outlet receptacle type, e.g. 'C13', 'NEMA 5-15R' (PDU/UPS only)
//   capacity     – max safe load the PDU/UPS can supply (PDU/UPS only)
//   capacityUnit – 'W' | 'VA' (PDU/UPS only)
//   inputVoltage – what the PDU/UPS itself draws from its upstream source (PDU/UPS only)

export const CATALOG_CATEGORIES = [
  { id: 'SERVERS',          label: 'Servers' },
  { id: 'FIREWALLS',        label: 'Firewalls' },
  { id: 'NETWORK',          label: 'Network' },
  { id: 'STORAGE',          label: 'Storage' },
  { id: 'POWER',            label: 'Power' },
  { id: 'PATCH PANELS',     label: 'Patch Panels' },
  { id: 'KVM',              label: 'KVM' },
  { id: 'AV/MEDIA',         label: 'AV/Media' },
  { id: 'COOLING',          label: 'Cooling' },
  { id: 'SHELVES',          label: 'Shelves' },
  { id: 'CHASSIS',          label: 'Chassis' },
  { id: 'BLANKS',           label: 'Blanks' },
  { id: 'CABLE MANAGEMENT', label: 'Cable Mgmt' },
];

export const VENDOR_COLORS = {
  Generic:        '#555',
  Ubiquiti:       '#006FFF',
  Cisco:          '#049fd9',
  Dell:           '#007DB8',
  HPE:            '#00B388',
  Fortinet:       '#EE3124',
  'Palo Alto':    '#FA582D',
  APC:            '#005F9E',
  CyberPower:     '#E31837',
  Eaton:          '#FDB827',
  MikroTik:       '#293896',
  Netgear:        '#9B0000',
  Juniper:        '#84B135',
  Synology:       '#B5B5B6',
  QNAP:           '#0EA0DA',
  Supermicro:     '#D40000',
  'TP-Link':      '#4CBFA4',
  Lenovo:         '#E2231A',
  'Raspberry Pi': '#C51A4A',
};

function e(id, name, vendor, category, uSize, renderType, opts = {}) {
  return {
    id, name, vendor, category, uSize, renderType,
    halfDepth: opts.halfDepth || false,
    halfWidth: opts.halfWidth || false,
    mountedFace: opts.mountedFace || 'front',
    powerDrawW:   opts.powerDrawW,
    outletCount:  opts.outletCount,
    outletType:   opts.outletType,
    capacity:     opts.capacity,
    capacityUnit: opts.capacityUnit,
    inputVoltage: opts.inputVoltage,
  };
}

export const RACK_CATALOG = [
  // ─── GENERIC / SERVERS ──────────────────────────────────────────────────────
  e('gen-server-1u',        'Server 1U',                    'Generic', 'SERVERS', 1, 'server', { powerDrawW: 350 }),
  e('gen-server-2u',        'Server 2U',                    'Generic', 'SERVERS', 2, 'server', { powerDrawW: 500 }),
  e('gen-server-3u',        'Server 3U',                    'Generic', 'SERVERS', 3, 'server', { powerDrawW: 650 }),
  e('gen-server-4u',        'Server 4U',                    'Generic', 'SERVERS', 4, 'server', { powerDrawW: 850 }),
  e('gen-blade-half-2u',    'Blade Server (Half-Width) 2U', 'Generic', 'SERVERS', 2, 'server', { halfWidth: true, halfDepth: true, powerDrawW: 300 }),
  e('gen-blade-full-4u',    'Blade Server (Full) 4U',       'Generic', 'SERVERS', 4, 'server', { halfDepth: true, powerDrawW: 850 }),
  e('gen-minipc-1u',        'Mini PC 1U',                   'Generic', 'SERVERS', 1, 'server', { halfWidth: true, halfDepth: true, powerDrawW: 65 }),

  // ─── GENERIC / CHASSIS ──────────────────────────────────────────────────────
  e('gen-blade-chassis-4u', 'Blade Chassis (4-Bay) 4U',    'Generic', 'CHASSIS', 4, 'server', { powerDrawW: 1600 }),
  e('gen-blade-chassis-7u', 'Blade Chassis (8-Bay) 7U',    'Generic', 'CHASSIS', 7, 'server', { powerDrawW: 2800 }),

  // ─── GENERIC / FIREWALLS ────────────────────────────────────────────────────
  e('gen-fw-1u', 'Router/Firewall 1U', 'Generic', 'FIREWALLS', 1, 'firewall', { powerDrawW: 40 }),
  e('gen-fw-2u', 'Router/Firewall 2U', 'Generic', 'FIREWALLS', 2, 'firewall', { powerDrawW: 90 }),

  // ─── GENERIC / NETWORK ──────────────────────────────────────────────────────
  e('gen-sw-24-1u',   'Switch (24-Port) 1U',    'Generic', 'NETWORK', 1, 'switch', { powerDrawW: 60 }),
  e('gen-sw-48-1u',   'Switch (48-Port) 1U',    'Generic', 'NETWORK', 1, 'switch', { powerDrawW: 120 }),
  e('gen-sw-half-1u', 'Switch (Half-Width) 1U', 'Generic', 'NETWORK', 1, 'switch', { halfWidth: true, halfDepth: true, powerDrawW: 30 }),

  // ─── GENERIC / STORAGE ──────────────────────────────────────────────────────
  e('gen-stor-1u', 'Storage 1U', 'Generic', 'STORAGE', 1, 'storage', { powerDrawW: 250 }),
  e('gen-stor-2u', 'Storage 2U', 'Generic', 'STORAGE', 2, 'storage', { powerDrawW: 400 }),
  e('gen-stor-3u', 'Storage 3U', 'Generic', 'STORAGE', 3, 'storage', { powerDrawW: 550 }),
  e('gen-stor-4u', 'Storage 4U', 'Generic', 'STORAGE', 4, 'storage', { powerDrawW: 750 }),

  // ─── GENERIC / POWER ────────────────────────────────────────────────────────
  e('gen-pdu-1u',      'PDU 1U',      'Generic', 'POWER', 1, 'pdu', { halfDepth: true, mountedFace: 'rear', outletCount: 8,  outletType: 'C13', capacity: 1920, capacityUnit: 'VA', inputVoltage: '120V' }),
  e('gen-pdu-2u',      'PDU 2U',      'Generic', 'POWER', 2, 'pdu', { halfDepth: true, mountedFace: 'rear', outletCount: 16, outletType: 'C13', capacity: 3840, capacityUnit: 'VA', inputVoltage: '208V' }),
  e('gen-ups-2u',      'UPS 2U',      'Generic', 'POWER', 2, 'ups', { outletCount: 6, outletType: 'NEMA 5-15R', capacity: 1500, capacityUnit: 'VA', inputVoltage: '120V' }),
  e('gen-ups-4u',      'UPS 4U',      'Generic', 'POWER', 4, 'ups', { outletCount: 8, outletType: 'NEMA 5-15R', capacity: 3000, capacityUnit: 'VA', inputVoltage: '208V' }),
  e('gen-mini-ups-1u', 'Mini UPS 1U', 'Generic', 'POWER', 1, 'ups', { halfWidth: true, halfDepth: true, outletCount: 4, outletType: 'NEMA 5-15R', capacity: 650, capacityUnit: 'VA', inputVoltage: '120V' }),

  // ─── GENERIC / PATCH PANELS ─────────────────────────────────────────────────
  e('gen-fiber-pp-1u', 'Fiber Patch Panel 1U',     'Generic', 'PATCH PANELS', 1, 'patch-panel', { halfDepth: true }),
  e('gen-pp-24-1u',    'Patch Panel (24-Port) 1U', 'Generic', 'PATCH PANELS', 1, 'patch-panel'),
  e('gen-pp-48-2u',    'Patch Panel (48-Port) 2U', 'Generic', 'PATCH PANELS', 2, 'patch-panel'),
  e('gen-half-pp-1u',  'Half Patch Panel 1U',      'Generic', 'PATCH PANELS', 1, 'patch-panel', { halfWidth: true, halfDepth: true }),

  // ─── GENERIC / KVM ──────────────────────────────────────────────────────────
  e('gen-kvm-drawer-1u', 'Console Drawer 1U', 'Generic', 'KVM', 1, 'kvm', { powerDrawW: 25 }),
  e('gen-kvm-switch-1u', 'KVM Switch 1U',     'Generic', 'KVM', 1, 'kvm', { powerDrawW: 15 }),

  // ─── GENERIC / AV/MEDIA ─────────────────────────────────────────────────────
  e('gen-amp-1u',       'Amplifier 1U',        'Generic', 'AV/MEDIA', 1, 'other', { powerDrawW: 100 }),
  e('gen-amp-2u',       'Amplifier 2U',        'Generic', 'AV/MEDIA', 2, 'other', { powerDrawW: 200 }),
  e('gen-audio-1u',     'Audio Processor 1U',  'Generic', 'AV/MEDIA', 1, 'other', { powerDrawW: 40 }),
  e('gen-avr-1u',       'AV Receiver 1U',      'Generic', 'AV/MEDIA', 1, 'other', { powerDrawW: 60 }),
  e('gen-avr-2u',       'AV Receiver 2U',      'Generic', 'AV/MEDIA', 2, 'other', { powerDrawW: 120 }),
  e('gen-pwramp-3u',    'Power Amplifier 3U',  'Generic', 'AV/MEDIA', 3, 'other', { powerDrawW: 400 }),
  e('gen-stream-1u',    'Streaming Encoder 1U','Generic', 'AV/MEDIA', 1, 'other', { powerDrawW: 50 }),
  e('gen-vidswitch-1u', 'Video Switcher 1U',   'Generic', 'AV/MEDIA', 1, 'other', { powerDrawW: 35 }),

  // ─── GENERIC / COOLING ──────────────────────────────────────────────────────
  e('gen-fan-1u',      'Fan Panel 1U',      'Generic', 'COOLING', 1, 'other', { halfDepth: true, powerDrawW: 20 }),
  e('gen-fan-2u',      'Fan Panel 2U',      'Generic', 'COOLING', 2, 'other', { halfDepth: true, powerDrawW: 35 }),
  e('gen-half-fan-1u', 'Half Fan Panel 1U', 'Generic', 'COOLING', 1, 'other', { halfWidth: true, halfDepth: true, powerDrawW: 12 }),

  // ─── GENERIC / SHELVES (passive — no power) ──────────────────────────────────
  e('gen-shelf-cant-1u', 'Cantilever Shelf 1U', 'Generic', 'SHELVES', 1, 'blank', { halfDepth: true }),
  e('gen-shelf-1u',      'Shelf 1U',            'Generic', 'SHELVES', 1, 'blank'),
  e('gen-shelf-2u',      'Shelf 2U',            'Generic', 'SHELVES', 2, 'blank'),
  e('gen-shelf-vent-1u', 'Vented Shelf 1U',     'Generic', 'SHELVES', 1, 'blank'),
  e('gen-shelf-2s-1u',   'Shelf (2-Slot) 1U',   'Generic', 'SHELVES', 1, 'blank'),
  e('gen-shelf-3s-1u',   'Shelf (3-Slot) 1U',   'Generic', 'SHELVES', 1, 'blank'),
  e('gen-shelf-2s-2u',   'Shelf (2-Slot) 2U',   'Generic', 'SHELVES', 2, 'blank'),
  e('gen-shelf-3s-2u',   'Shelf (3-Slot) 2U',   'Generic', 'SHELVES', 2, 'blank'),
  e('gen-half-shelf-1u', 'Half Shelf 1U',        'Generic', 'SHELVES', 1, 'blank', { halfWidth: true, halfDepth: true }),

  // ─── GENERIC / BLANKS (passive — no power) ───────────────────────────────────
  e('gen-blank-1u',      'Blank Panel 1U',      'Generic', 'BLANKS', 1, 'blank'),
  e('gen-blank-2u',      'Blank Panel 2U',      'Generic', 'BLANKS', 2, 'blank'),
  e('gen-blank-3u',      'Blank Panel 3U',      'Generic', 'BLANKS', 3, 'blank'),
  e('gen-blank-4u',      'Blank Panel 4U',      'Generic', 'BLANKS', 4, 'blank'),
  e('gen-half-blank-1u', 'Half Blank 1U',       'Generic', 'BLANKS', 1, 'blank', { halfWidth: true, halfDepth: true }),
  e('gen-half-blank-2u', 'Half Blank 2U',       'Generic', 'BLANKS', 2, 'blank', { halfWidth: true, halfDepth: true }),

  // ─── GENERIC / CABLE MANAGEMENT (passive — no power) ─────────────────────────
  e('gen-brush-1u',      'Brush Panel 1U',      'Generic', 'CABLE MANAGEMENT', 1, 'cable-manager', { halfDepth: true }),
  e('gen-cable-1u',      'Cable Manager 1U',    'Generic', 'CABLE MANAGEMENT', 1, 'cable-manager'),
  e('gen-cable-2u',      'Cable Manager 2U',    'Generic', 'CABLE MANAGEMENT', 2, 'cable-manager'),
  e('gen-half-brush-1u', 'Half Brush Panel 1U', 'Generic', 'CABLE MANAGEMENT', 1, 'cable-manager', { halfWidth: true, halfDepth: true }),

  // ─── UBIQUITI ────────────────────────────────────────────────────────────────
  e('ub-usw-pro-48',     'UniFi Switch Pro 48',            'Ubiquiti', 'NETWORK',      1, 'switch', { powerDrawW: 70 }),
  e('ub-usw-pro-24',     'UniFi Switch Pro 24',            'Ubiquiti', 'NETWORK',      1, 'switch', { powerDrawW: 45 }),
  e('ub-usw-ent-48-poe', 'UniFi Switch Enterprise 48 PoE', 'Ubiquiti', 'NETWORK',      1, 'switch', { powerDrawW: 130 }),
  e('ub-usw-pro-max-48', 'UniFi Switch Pro Max 48 PoE',    'Ubiquiti', 'NETWORK',      1, 'switch', { powerDrawW: 150 }),
  e('ub-usw-agg',        'UniFi Switch Aggregation',       'Ubiquiti', 'NETWORK',      1, 'switch', { powerDrawW: 35 }),
  e('ub-usw-lite-16',    'UniFi Switch Lite 16',           'Ubiquiti', 'NETWORK',      1, 'switch', { powerDrawW: 20 }),
  e('ub-udm-pro',        'UniFi Dream Machine Pro',        'Ubiquiti', 'FIREWALLS',    1, 'firewall', { powerDrawW: 50 }),
  e('ub-udm-se',         'UniFi Dream Machine SE',         'Ubiquiti', 'FIREWALLS',    1, 'firewall', { powerDrawW: 70 }),
  e('ub-udm-pro-max',    'UniFi Dream Machine Pro Max',    'Ubiquiti', 'FIREWALLS',    1, 'firewall', { powerDrawW: 90 }),
  e('ub-unvr',           'UniFi NVR',                      'Ubiquiti', 'STORAGE',      2, 'storage', { powerDrawW: 80 }),
  e('ub-unvr-pro',       'UniFi NVR Pro',                  'Ubiquiti', 'STORAGE',      2, 'storage', { powerDrawW: 100 }),
  e('ub-uck-g2-plus',    'UniFi CloudKey Gen2 Plus',       'Ubiquiti', 'SERVERS',      1, 'server', { powerDrawW: 15 }),
  e('ub-upp-48',         'UniFi 48-Port PoE Patch Panel',  'Ubiquiti', 'PATCH PANELS', 1, 'patch-panel'),

  // ─── CISCO ───────────────────────────────────────────────────────────────────
  e('ci-cat-9300-48p',  'Catalyst 9300-48P',   'Cisco', 'NETWORK',   1, 'switch', { powerDrawW: 150 }),
  e('ci-cat-9300-24p',  'Catalyst 9300-24P',   'Cisco', 'NETWORK',   1, 'switch', { powerDrawW: 100 }),
  e('ci-cat-9200-48p',  'Catalyst 9200-48P',   'Cisco', 'NETWORK',   1, 'switch', { powerDrawW: 120 }),
  e('ci-cat-9200-24p',  'Catalyst 9200-24P',   'Cisco', 'NETWORK',   1, 'switch', { powerDrawW: 80 }),
  e('ci-cat-9500-48',   'Catalyst 9500-48Y4C', 'Cisco', 'NETWORK',   1, 'switch', { powerDrawW: 250 }),
  e('ci-mr-355',        'Meraki MS355-48X2',   'Cisco', 'NETWORK',   1, 'switch', { powerDrawW: 150 }),
  e('ci-asa-5506',      'ASA 5506-X',          'Cisco', 'FIREWALLS', 1, 'firewall', { powerDrawW: 30 }),
  e('ci-asa-5516',      'ASA 5516-X',          'Cisco', 'FIREWALLS', 1, 'firewall', { powerDrawW: 60 }),
  e('ci-isr-4331',      'ISR 4331',            'Cisco', 'FIREWALLS', 1, 'firewall', { powerDrawW: 70 }),
  e('ci-isr-4351',      'ISR 4351',            'Cisco', 'FIREWALLS', 2, 'firewall', { powerDrawW: 110 }),
  e('ci-mx-250',        'Meraki MX250',        'Cisco', 'FIREWALLS', 1, 'firewall', { powerDrawW: 90 }),
  e('ci-mx-450',        'Meraki MX450',        'Cisco', 'FIREWALLS', 1, 'firewall', { powerDrawW: 150 }),

  // ─── DELL ────────────────────────────────────────────────────────────────────
  e('dl-r250',   'PowerEdge R250',    'Dell', 'SERVERS', 1, 'server', { powerDrawW: 250 }),
  e('dl-r350',   'PowerEdge R350',    'Dell', 'SERVERS', 1, 'server', { powerDrawW: 280 }),
  e('dl-r450',   'PowerEdge R450',    'Dell', 'SERVERS', 1, 'server', { powerDrawW: 350 }),
  e('dl-r550',   'PowerEdge R550',    'Dell', 'SERVERS', 2, 'server', { powerDrawW: 500 }),
  e('dl-r650',   'PowerEdge R650',    'Dell', 'SERVERS', 1, 'server', { powerDrawW: 400 }),
  e('dl-r650xs', 'PowerEdge R650xs',  'Dell', 'SERVERS', 1, 'server', { powerDrawW: 380 }),
  e('dl-r750',   'PowerEdge R750',    'Dell', 'SERVERS', 2, 'server', { powerDrawW: 600 }),
  e('dl-r750xs', 'PowerEdge R750xs',  'Dell', 'SERVERS', 2, 'server', { powerDrawW: 550 }),
  e('dl-r760',   'PowerEdge R760',    'Dell', 'SERVERS', 2, 'server', { powerDrawW: 650 }),
  e('dl-r960',   'PowerEdge R960',    'Dell', 'SERVERS', 4, 'server', { powerDrawW: 1100 }),
  e('dl-me5024', 'PowerVault ME5024', 'Dell', 'STORAGE', 2, 'storage', { powerDrawW: 350 }),
  e('dl-me5084', 'PowerVault ME5084', 'Dell', 'STORAGE', 5, 'storage', { powerDrawW: 700 }),
  e('dl-unity',  'EMC Unity XT 380',  'Dell', 'STORAGE', 2, 'storage', { powerDrawW: 450 }),

  // ─── HPE ─────────────────────────────────────────────────────────────────────
  e('hp-dl20-g10p',      'ProLiant DL20 Gen10 Plus',  'HPE', 'SERVERS', 1, 'server', { powerDrawW: 200 }),
  e('hp-dl360-g10',      'ProLiant DL360 Gen10',      'HPE', 'SERVERS', 1, 'server', { powerDrawW: 350 }),
  e('hp-dl360-g10p',     'ProLiant DL360 Gen10 Plus', 'HPE', 'SERVERS', 1, 'server', { powerDrawW: 380 }),
  e('hp-dl380-g10',      'ProLiant DL380 Gen10',      'HPE', 'SERVERS', 2, 'server', { powerDrawW: 550 }),
  e('hp-dl380-g10p',     'ProLiant DL380 Gen10 Plus', 'HPE', 'SERVERS', 2, 'server', { powerDrawW: 580 }),
  e('hp-dl560-g10',      'ProLiant DL560 Gen10',      'HPE', 'SERVERS', 2, 'server', { powerDrawW: 750 }),
  e('hp-dl580-g10',      'ProLiant DL580 Gen10',      'HPE', 'SERVERS', 4, 'server', { powerDrawW: 1200 }),
  e('hp-aruba-2930f-48', 'Aruba 2930F-48G',           'HPE', 'NETWORK', 1, 'switch', { powerDrawW: 90 }),
  e('hp-aruba-2930f-24', 'Aruba 2930F-24G',           'HPE', 'NETWORK', 1, 'switch', { powerDrawW: 60 }),
  e('hp-aruba-6300m',    'Aruba 6300M 48-Port',       'HPE', 'NETWORK', 1, 'switch', { powerDrawW: 130 }),
  e('hp-aruba-6405',     'Aruba 6405 Switch',         'HPE', 'NETWORK', 7, 'switch', { powerDrawW: 600 }),
  e('hp-msa-2060',       'MSA 2060 SAS',              'HPE', 'STORAGE', 2, 'storage', { powerDrawW: 400 }),

  // ─── FORTINET ────────────────────────────────────────────────────────────────
  e('ft-fg-40f',   'FortiGate 40F',        'Fortinet', 'FIREWALLS', 1, 'firewall', { powerDrawW: 20 }),
  e('ft-fg-60f',   'FortiGate 60F',        'Fortinet', 'FIREWALLS', 1, 'firewall', { powerDrawW: 25 }),
  e('ft-fg-80f',   'FortiGate 80F',        'Fortinet', 'FIREWALLS', 1, 'firewall', { powerDrawW: 35 }),
  e('ft-fg-100f',  'FortiGate 100F',       'Fortinet', 'FIREWALLS', 1, 'firewall', { powerDrawW: 45 }),
  e('ft-fg-200f',  'FortiGate 200F',       'Fortinet', 'FIREWALLS', 1, 'firewall', { powerDrawW: 60 }),
  e('ft-fg-400e',  'FortiGate 400E',       'Fortinet', 'FIREWALLS', 2, 'firewall', { powerDrawW: 100 }),
  e('ft-fg-600e',  'FortiGate 600E',       'Fortinet', 'FIREWALLS', 2, 'firewall', { powerDrawW: 140 }),
  e('ft-fg-900d',  'FortiGate 900D',       'Fortinet', 'FIREWALLS', 2, 'firewall', { powerDrawW: 180 }),
  e('ft-fsw-148f', 'FortiSwitch 148F-POE', 'Fortinet', 'NETWORK',   1, 'switch', { powerDrawW: 70 }),
  e('ft-fsw-248e', 'FortiSwitch 248E-POE', 'Fortinet', 'NETWORK',   1, 'switch', { powerDrawW: 100 }),
  e('ft-fsw-448e', 'FortiSwitch 448E',     'Fortinet', 'NETWORK',   1, 'switch', { powerDrawW: 90 }),

  // ─── PALO ALTO ───────────────────────────────────────────────────────────────
  e('pa-220',  'PA-220',  'Palo Alto', 'FIREWALLS', 1, 'firewall', { powerDrawW: 20 }),
  e('pa-440',  'PA-440',  'Palo Alto', 'FIREWALLS', 1, 'firewall', { powerDrawW: 25 }),
  e('pa-450',  'PA-450',  'Palo Alto', 'FIREWALLS', 1, 'firewall', { powerDrawW: 30 }),
  e('pa-460',  'PA-460',  'Palo Alto', 'FIREWALLS', 1, 'firewall', { powerDrawW: 35 }),
  e('pa-850',  'PA-850',  'Palo Alto', 'FIREWALLS', 2, 'firewall', { powerDrawW: 65 }),
  e('pa-3220', 'PA-3220', 'Palo Alto', 'FIREWALLS', 2, 'firewall', { powerDrawW: 180 }),
  e('pa-3250', 'PA-3250', 'Palo Alto', 'FIREWALLS', 2, 'firewall', { powerDrawW: 220 }),
  e('pa-3260', 'PA-3260', 'Palo Alto', 'FIREWALLS', 2, 'firewall', { powerDrawW: 260 }),
  e('pa-5220', 'PA-5220', 'Palo Alto', 'FIREWALLS', 2, 'firewall', { powerDrawW: 400 }),
  e('pa-5250', 'PA-5250', 'Palo Alto', 'FIREWALLS', 2, 'firewall', { powerDrawW: 550 }),

  // ─── APC ─────────────────────────────────────────────────────────────────────
  e('apc-su1000-2u',   'Smart-UPS 1000VA',      'APC', 'POWER', 2, 'ups', { outletCount: 6, outletType: 'NEMA 5-15R', capacity: 1000,  capacityUnit: 'VA', inputVoltage: '120V' }),
  e('apc-su1500-2u',   'Smart-UPS 1500VA',      'APC', 'POWER', 2, 'ups', { outletCount: 8, outletType: 'NEMA 5-15R', capacity: 1500,  capacityUnit: 'VA', inputVoltage: '120V' }),
  e('apc-su2200-2u',   'Smart-UPS 2200VA',      'APC', 'POWER', 2, 'ups', { outletCount: 8, outletType: 'NEMA 5-15R', capacity: 2200,  capacityUnit: 'VA', inputVoltage: '120V' }),
  e('apc-su3000-2u',   'Smart-UPS 3000VA',      'APC', 'POWER', 2, 'ups', { outletCount: 8, outletType: 'NEMA 5-15R', capacity: 3000,  capacityUnit: 'VA', inputVoltage: '208V' }),
  e('apc-srt5000-3u',  'Smart-UPS SRT 5000VA',  'APC', 'POWER', 3, 'ups', { outletCount: 6, outletType: 'C13',        capacity: 5000,  capacityUnit: 'VA', inputVoltage: '208V' }),
  e('apc-srt8000-4u',  'Smart-UPS SRT 8000VA',  'APC', 'POWER', 4, 'ups', { outletCount: 8, outletType: 'C13',        capacity: 8000,  capacityUnit: 'VA', inputVoltage: '208V' }),
  e('apc-srt10000-6u', 'Smart-UPS SRT 10000VA', 'APC', 'POWER', 6, 'ups', { outletCount: 8, outletType: 'C19',        capacity: 10000, capacityUnit: 'VA', inputVoltage: '240V' }),
  e('apc-pdu-7920',    'Rack PDU AP7920B',       'APC', 'POWER', 1, 'pdu', { halfDepth: true, mountedFace: 'rear', outletCount: 8,  outletType: 'C13', capacity: 1920, capacityUnit: 'VA', inputVoltage: '120V' }),
  e('apc-pdu-7921',    'Rack PDU AP7921B',       'APC', 'POWER', 1, 'pdu', { halfDepth: true, mountedFace: 'rear', outletCount: 8,  outletType: 'C13', capacity: 1920, capacityUnit: 'VA', inputVoltage: '120V' }),
  e('apc-pdu-7922',    'Rack PDU AP7922B',       'APC', 'POWER', 1, 'pdu', { halfDepth: true, mountedFace: 'rear', outletCount: 16, outletType: 'C13', capacity: 1920, capacityUnit: 'VA', inputVoltage: '120V' }),
  e('apc-pdu-7853',    'Metered PDU AP7853',     'APC', 'POWER', 1, 'pdu', { halfDepth: true, mountedFace: 'rear', outletCount: 24, outletType: 'C13', capacity: 3840, capacityUnit: 'VA', inputVoltage: '208V' }),

  // ─── CYBERPOWER ──────────────────────────────────────────────────────────────
  e('cp-or1000-1u', 'OR1000LCDRT1U',  'CyberPower', 'POWER', 1, 'ups', { outletCount: 6, outletType: 'NEMA 5-15R', capacity: 1000, capacityUnit: 'VA', inputVoltage: '120V' }),
  e('cp-or1500-2u', 'OR1500LCDRT2U',  'CyberPower', 'POWER', 2, 'ups', { outletCount: 8, outletType: 'NEMA 5-15R', capacity: 1500, capacityUnit: 'VA', inputVoltage: '120V' }),
  e('cp-or2200-2u', 'OR2200LCDRT2U',  'CyberPower', 'POWER', 2, 'ups', { outletCount: 8, outletType: 'NEMA 5-15R', capacity: 2200, capacityUnit: 'VA', inputVoltage: '120V' }),
  e('cp-or3000-2u', 'OR3000LCDRT2U',  'CyberPower', 'POWER', 2, 'ups', { outletCount: 8, outletType: 'NEMA 5-15R', capacity: 3000, capacityUnit: 'VA', inputVoltage: '208V' }),
  e('cp-pdu-15b',   'PDU15B2F12R',    'CyberPower', 'POWER', 1, 'pdu', { halfDepth: true, mountedFace: 'rear', outletCount: 12, outletType: 'C13', capacity: 1800, capacityUnit: 'VA', inputVoltage: '120V' }),
  e('cp-pdu-20b',   'PDU20B2F20R',    'CyberPower', 'POWER', 1, 'pdu', { halfDepth: true, mountedFace: 'rear', outletCount: 20, outletType: 'C13', capacity: 2400, capacityUnit: 'VA', inputVoltage: '120V' }),

  // ─── EATON ───────────────────────────────────────────────────────────────────
  e('ea-5px-1000-1u',  '5PX 1000VA',         'Eaton', 'POWER', 1, 'ups', { outletCount: 4, outletType: 'NEMA 5-15R', capacity: 1000, capacityUnit: 'VA', inputVoltage: '120V' }),
  e('ea-5px-1500-2u',  '5PX 1500VA',         'Eaton', 'POWER', 2, 'ups', { outletCount: 8, outletType: 'NEMA 5-15R', capacity: 1500, capacityUnit: 'VA', inputVoltage: '120V' }),
  e('ea-5px-2200-2u',  '5PX 2200VA',         'Eaton', 'POWER', 2, 'ups', { outletCount: 8, outletType: 'NEMA 5-15R', capacity: 2200, capacityUnit: 'VA', inputVoltage: '120V' }),
  e('ea-5px-3000-2u',  '5PX 3000VA',         'Eaton', 'POWER', 2, 'ups', { outletCount: 8, outletType: 'NEMA 5-15R', capacity: 3000, capacityUnit: 'VA', inputVoltage: '208V' }),
  e('ea-9px-2000rt-2u', '9PX2000RT',          'Eaton', 'POWER', 2, 'ups', { outletCount: 6, outletType: 'C13', capacity: 2000, capacityUnit: 'VA', inputVoltage: '208V' }),
  e('ea-9px-5ktf5g2-6u',    '9PX5KTF5G2',        'Eaton', 'POWER', 6, 'ups', { outletCount: 6, outletType: 'C13', capacity: 5000, capacityUnit: 'VA', inputVoltage: '208V' }),
  // External battery modules — extend runtime only, no outlets of their own.
  e('ea-9pxebm180rtg2-3u', '9PXEBM180RTG2',     'Eaton', 'POWER', 3, 'ups'),
  e('ea-9pxebm72rt-2u',    '9PXEBM72RT',        'Eaton', 'POWER', 2, 'ups'),
  e('ea-9px-5000-3u',      '9PX 5000VA',         'Eaton', 'POWER', 3, 'ups', { outletCount: 6, outletType: 'C13', capacity: 5000, capacityUnit: 'VA', inputVoltage: '208V' }),
  e('ea-9px-8000-4u',      '9PX 8000VA',         'Eaton', 'POWER', 4, 'ups', { outletCount: 8, outletType: 'C13', capacity: 8000, capacityUnit: 'VA', inputVoltage: '208V' }),
  e('ea-epdu-1u',      'ePDU G3 Metered 1U', 'Eaton', 'POWER', 1, 'pdu', { halfDepth: true, mountedFace: 'rear', outletCount: 16, outletType: 'C13', capacity: 2880, capacityUnit: 'VA', inputVoltage: '208V' }),

  // ─── MIKROTIK ────────────────────────────────────────────────────────────────
  e('mt-crs328',  'CRS328-24P-4S+RM',    'MikroTik', 'NETWORK',   1, 'switch', { powerDrawW: 50 }),
  e('mt-crs354',  'CRS354-48G-4S+2Q+RM', 'MikroTik', 'NETWORK',   1, 'switch', { powerDrawW: 70 }),
  e('mt-crs326',  'CRS326-24G-2S+RM',    'MikroTik', 'NETWORK',   1, 'switch', { powerDrawW: 25 }),
  e('mt-ccr2004', 'CCR2004-1G-12S+2XS',  'MikroTik', 'FIREWALLS', 1, 'firewall', { powerDrawW: 35 }),
  e('mt-ccr2116', 'CCR2116-12G-4S+',     'MikroTik', 'FIREWALLS', 1, 'firewall', { powerDrawW: 40 }),
  e('mt-rb4011',  'RB4011iGS+RM',        'MikroTik', 'FIREWALLS', 1, 'firewall', { powerDrawW: 20 }),
  e('mt-ccr1036', 'CCR1036-12G-4S',      'MikroTik', 'FIREWALLS', 1, 'firewall', { powerDrawW: 65 }),

  // ─── NETGEAR ─────────────────────────────────────────────────────────────────
  e('ng-m4350',    'M4350-24X4V',          'Netgear', 'NETWORK',  1, 'switch', { powerDrawW: 60 }),
  e('ng-m4300-28', 'M4300-28G',            'Netgear', 'NETWORK',  1, 'switch', { powerDrawW: 50 }),
  e('ng-m4300-52', 'M4300-52G',            'Netgear', 'NETWORK',  1, 'switch', { powerDrawW: 80 }),
  e('ng-m4250',    'AV Line M4250-40G8XF', 'Netgear', 'NETWORK',  1, 'switch', { powerDrawW: 90 }),
  e('ng-rn3312',   'ReadyNAS 3312',         'Netgear', 'STORAGE',  2, 'storage', { powerDrawW: 300 }),
  e('ng-rn4312x',  'ReadyNAS 4312X',        'Netgear', 'STORAGE',  2, 'storage', { powerDrawW: 350 }),

  // ─── JUNIPER ─────────────────────────────────────────────────────────────────
  e('ju-ex2300-48', 'EX2300-48P',  'Juniper', 'NETWORK',   1, 'switch', { powerDrawW: 100 }),
  e('ju-ex2300-24', 'EX2300-24P',  'Juniper', 'NETWORK',   1, 'switch', { powerDrawW: 70 }),
  e('ju-ex3400-48', 'EX3400-48P',  'Juniper', 'NETWORK',   1, 'switch', { powerDrawW: 130 }),
  e('ju-ex4300-48', 'EX4300-48MP', 'Juniper', 'NETWORK',   1, 'switch', { powerDrawW: 150 }),
  e('ju-srx300',    'SRX300',      'Juniper', 'FIREWALLS', 1, 'firewall', { powerDrawW: 20 }),
  e('ju-srx320',    'SRX320',      'Juniper', 'FIREWALLS', 1, 'firewall', { powerDrawW: 25 }),
  e('ju-srx380',    'SRX380',      'Juniper', 'FIREWALLS', 1, 'firewall', { powerDrawW: 40 }),

  // ─── SYNOLOGY ────────────────────────────────────────────────────────────────
  e('sy-rs422',    'RS422+',      'Synology', 'STORAGE', 1, 'storage', { powerDrawW: 80 }),
  e('sy-rs822',    'RS822+',      'Synology', 'STORAGE', 1, 'storage', { powerDrawW: 100 }),
  e('sy-rs822rp',  'RS822RP+',    'Synology', 'STORAGE', 1, 'storage', { powerDrawW: 100 }),
  e('sy-rs1221',   'RS1221+',     'Synology', 'STORAGE', 2, 'storage', { powerDrawW: 150 }),
  e('sy-rs1221rp', 'RS1221RP+',   'Synology', 'STORAGE', 2, 'storage', { powerDrawW: 150 }),
  e('sy-rs3621xs', 'RS3621xs+',   'Synology', 'STORAGE', 2, 'storage', { powerDrawW: 250 }),
  e('sy-rs3621rp', 'RS3621RPxs',  'Synology', 'STORAGE', 2, 'storage', { powerDrawW: 250 }),
  e('sy-rs4021xs', 'RS4021xs+',   'Synology', 'STORAGE', 2, 'storage', { powerDrawW: 300 }),
  e('sy-rx1223rp', 'RX1223RP',    'Synology', 'STORAGE', 2, 'storage', { powerDrawW: 200 }),

  // ─── QNAP ────────────────────────────────────────────────────────────────────
  e('qn-ts-h1277', 'TS-h1277XU-RP', 'QNAP', 'STORAGE', 2, 'storage', { powerDrawW: 300 }),
  e('qn-ts-h1677', 'TS-h1677XU-RP', 'QNAP', 'STORAGE', 2, 'storage', { powerDrawW: 350 }),
  e('qn-ts-h2477', 'TS-h2477XU-RP', 'QNAP', 'STORAGE', 2, 'storage', { powerDrawW: 400 }),
  e('qn-ts-h3087', 'TS-h3087XU-RP', 'QNAP', 'STORAGE', 3, 'storage', { powerDrawW: 550 }),
  e('qn-tl-r1200', 'TL-R1200S-RP',  'QNAP', 'STORAGE', 2, 'storage', { powerDrawW: 250 }),
  e('qn-tl-d400',  'TL-D400S',      'QNAP', 'STORAGE', 2, 'storage', { powerDrawW: 200 }),

  // ─── SUPERMICRO ──────────────────────────────────────────────────────────────
  e('sm-1019p',     'SuperServer 1019P-WTR',       'Supermicro', 'SERVERS', 1, 'server', { powerDrawW: 300 }),
  e('sm-2029p',     'SuperServer 2029P-C1RT',      'Supermicro', 'SERVERS', 2, 'server', { powerDrawW: 500 }),
  e('sm-6029p',     'SuperServer 6029P-WTR',       'Supermicro', 'SERVERS', 2, 'server', { powerDrawW: 550 }),
  e('sm-7049p',     'SuperServer 7049P-TR',        'Supermicro', 'SERVERS', 4, 'server', { powerDrawW: 900 }),
  e('sm-stor-2029', 'SuperStorage 2029P-DN2R48L',  'Supermicro', 'STORAGE', 2, 'storage', { powerDrawW: 650 }),
  e('sm-mc',        'MicroCloud SYS-5039MC-H8TRF', 'Supermicro', 'CHASSIS', 3, 'server', { powerDrawW: 1200 }),

  // ─── TP-LINK ─────────────────────────────────────────────────────────────────
  e('tl-sg3428x',  'TL-SG3428X',  'TP-Link', 'NETWORK',   1, 'switch', { powerDrawW: 50 }),
  e('tl-sg3452p',  'TL-SG3452P',  'TP-Link', 'NETWORK',   1, 'switch', { powerDrawW: 110 }),
  e('tl-sg3452xp', 'TL-SG3452XP', 'TP-Link', 'NETWORK',   1, 'switch', { powerDrawW: 130 }),
  e('tl-er8411',   'TL-ER8411',   'TP-Link', 'FIREWALLS', 1, 'firewall', { powerDrawW: 25 }),
  e('tl-er7212pc', 'TL-ER7212PC', 'TP-Link', 'FIREWALLS', 1, 'firewall', { powerDrawW: 20 }),

  // ─── LENOVO ──────────────────────────────────────────────────────────────────
  e('lv-sr250v2', 'ThinkSystem SR250 V2', 'Lenovo', 'SERVERS', 1, 'server', { powerDrawW: 250 }),
  e('lv-sr630v3', 'ThinkSystem SR630 V3', 'Lenovo', 'SERVERS', 1, 'server', { powerDrawW: 380 }),
  e('lv-sr650v3', 'ThinkSystem SR650 V3', 'Lenovo', 'SERVERS', 2, 'server', { powerDrawW: 550 }),
  e('lv-sr850v2', 'ThinkSystem SR850 V2', 'Lenovo', 'SERVERS', 2, 'server', { powerDrawW: 750 }),
  e('lv-sr950v3', 'ThinkSystem SR950 V3', 'Lenovo', 'SERVERS', 4, 'server', { powerDrawW: 1100 }),
  e('lv-de4000h', 'ThinkSystem DE4000H',  'Lenovo', 'STORAGE', 2, 'storage', { powerDrawW: 400 }),

  // ─── RASPBERRY PI ────────────────────────────────────────────────────────────
  e('rpi-1u-4x', 'Rack Mount 1U (4x Pi)', 'Raspberry Pi', 'SERVERS', 1, 'server', { powerDrawW: 30 }),
  e('rpi-2u-8x', 'Rack Mount 2U (8x Pi)', 'Raspberry Pi', 'SERVERS', 2, 'server', { powerDrawW: 60 }),
];

// Sorted vendor list: Generic first, rest alphabetical
export const CATALOG_VENDORS = [
  'Generic',
  ...new Set(RACK_CATALOG.filter((x) => x.vendor !== 'Generic').map((x) => x.vendor).sort()),
];

export function groupByVendor(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (!map.has(entry.vendor)) map.set(entry.vendor, []);
    map.get(entry.vendor).push(entry);
  }
  return map;
}

export function groupByCategory(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (!map.has(entry.category)) map.set(entry.category, []);
    map.get(entry.category).push(entry);
  }
  return map;
}

// Find a catalog entry whose name matches a device's model field.
// Tries exact case-insensitive match, then "Vendor Name" combined form,
// then suffix match so "Eaton 9PX2000RT" → "9PX2000RT" still resolves.
export function findCatalogEntryByModel(model) {
  if (!model) return null;
  const needle = model.trim().toLowerCase();
  return (
    RACK_CATALOG.find((e) => e.name.toLowerCase() === needle) ||
    RACK_CATALOG.find((e) => `${e.vendor} ${e.name}`.toLowerCase() === needle) ||
    RACK_CATALOG.find((e) => needle.endsWith(e.name.toLowerCase())) ||
    null
  );
}

// Catalog entries usable as a PDU/UPS power source (for vertical PDU placement).
export function powerSourceCatalogEntries() {
  return RACK_CATALOG.filter((entry) => entry.renderType === 'pdu' || entry.renderType === 'ups');
}
