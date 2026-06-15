// Static device catalog shown in the Device Catalog slide-out panel.
// Each entry can be dragged onto a rack (text/catalog-item) to create a
// rack_slots row with item_type/custom_type/catalog_id/vendor populated from
// here. `renderType` keys into deviceRenderConfig.js for the faceplate.
// `frontBack` is the default face the device is placed on (PDUs/cable
// managers default to the rear).

export const CATALOG_CATEGORIES = [
  { id: 'all', label: 'All' },
  { id: 'networking', label: 'Networking' },
  { id: 'servers', label: 'Servers' },
  { id: 'storage', label: 'Storage' },
  { id: 'power', label: 'Power' },
  { id: 'patch-cable', label: 'Patch & Cable' },
  { id: 'custom', label: 'Custom' },
];

export const RACK_CATALOG = [
  // --- Networking (13) -----------------------------------------------------
  { id: 'ubiquiti-usw-pro-48', name: 'UniFi Switch Pro 48', vendor: 'Ubiquiti', category: 'networking', renderType: 'switch', uSize: 1, frontBack: 'front' },
  { id: 'ubiquiti-usw-pro-24', name: 'UniFi Switch Pro 24', vendor: 'Ubiquiti', category: 'networking', renderType: 'switch', uSize: 1, frontBack: 'front' },
  { id: 'ubiquiti-usw-lite-16-poe', name: 'UniFi Switch Lite 16 PoE', vendor: 'Ubiquiti', category: 'networking', renderType: 'switch', uSize: 1, frontBack: 'front' },
  { id: 'ubiquiti-usw-pro-aggregation', name: 'UniFi Switch Pro Aggregation', vendor: 'Ubiquiti', category: 'networking', renderType: 'switch', uSize: 1, frontBack: 'front' },
  { id: 'ubiquiti-udm-pro', name: 'UniFi Dream Machine Pro', vendor: 'Ubiquiti', category: 'networking', renderType: 'firewall', uSize: 1, frontBack: 'front' },
  { id: 'ubiquiti-u6-shelf-ap', name: 'UniFi U6-Enterprise (Shelf Mount)', vendor: 'Ubiquiti', category: 'networking', renderType: 'ap', uSize: 1, frontBack: 'front' },
  { id: 'cisco-catalyst-9300-48p', name: 'Catalyst 9300-48P', vendor: 'Cisco', category: 'networking', renderType: 'switch', uSize: 1, frontBack: 'front' },
  { id: 'cisco-catalyst-2960x', name: 'Catalyst 2960-X', vendor: 'Cisco', category: 'networking', renderType: 'switch', uSize: 1, frontBack: 'front' },
  { id: 'cisco-isr-4451', name: 'ISR 4451 Router', vendor: 'Cisco', category: 'networking', renderType: 'firewall', uSize: 1, frontBack: 'front' },
  { id: 'fortinet-fortigate-100f', name: 'FortiGate 100F', vendor: 'Fortinet', category: 'networking', renderType: 'firewall', uSize: 1, frontBack: 'front' },
  { id: 'paloalto-pa-820', name: 'PA-820', vendor: 'Palo Alto Networks', category: 'networking', renderType: 'firewall', uSize: 1, frontBack: 'front' },
  { id: 'netgear-prosafe-48', name: 'ProSAFE 48-Port', vendor: 'Netgear', category: 'networking', renderType: 'switch', uSize: 1, frontBack: 'front' },
  { id: 'juniper-ex4300-48t', name: 'EX4300-48T', vendor: 'Juniper', category: 'networking', renderType: 'switch', uSize: 1, frontBack: 'front' },

  // --- Servers (7) -----------------------------------------------------------
  { id: 'dell-poweredge-r740', name: 'PowerEdge R740', vendor: 'Dell', category: 'servers', renderType: 'server', uSize: 2, frontBack: 'front' },
  { id: 'dell-poweredge-r640', name: 'PowerEdge R640', vendor: 'Dell', category: 'servers', renderType: 'server', uSize: 1, frontBack: 'front' },
  { id: 'dell-poweredge-r750', name: 'PowerEdge R750', vendor: 'Dell', category: 'servers', renderType: 'server', uSize: 2, frontBack: 'front' },
  { id: 'hpe-proliant-dl380-g10', name: 'ProLiant DL380 Gen10', vendor: 'HPE', category: 'servers', renderType: 'server', uSize: 2, frontBack: 'front' },
  { id: 'hpe-proliant-dl360-g10', name: 'ProLiant DL360 Gen10', vendor: 'HPE', category: 'servers', renderType: 'server', uSize: 1, frontBack: 'front' },
  { id: 'supermicro-1029p', name: 'SuperServer 1029P', vendor: 'Supermicro', category: 'servers', renderType: 'server', uSize: 1, frontBack: 'front' },
  { id: 'lenovo-thinksystem-sr650', name: 'ThinkSystem SR650', vendor: 'Lenovo', category: 'servers', renderType: 'server', uSize: 2, frontBack: 'front' },

  // --- Storage (4) -------------------------------------------------------------
  { id: 'synology-rs3621xs-plus', name: 'RackStation RS3621xs+', vendor: 'Synology', category: 'storage', renderType: 'storage', uSize: 2, frontBack: 'front' },
  { id: 'qnap-ts-1283xu-rp', name: 'TS-1283XU-RP', vendor: 'QNAP', category: 'storage', renderType: 'storage', uSize: 2, frontBack: 'front' },
  { id: 'dell-powervault-me4024', name: 'PowerVault ME4024', vendor: 'Dell', category: 'storage', renderType: 'storage', uSize: 2, frontBack: 'front' },
  { id: 'netapp-fas2750', name: 'FAS2750', vendor: 'NetApp', category: 'storage', renderType: 'storage', uSize: 3, frontBack: 'front' },

  // --- Power (9) -----------------------------------------------------------
  { id: 'apc-smart-ups-1500-rm', name: 'Smart-UPS 1500VA RM', vendor: 'APC', category: 'power', renderType: 'ups', uSize: 2, frontBack: 'front' },
  { id: 'apc-smart-ups-3000-rm', name: 'Smart-UPS 3000VA RM', vendor: 'APC', category: 'power', renderType: 'ups', uSize: 3, frontBack: 'front' },
  { id: 'apc-switched-pdu-ap7920', name: 'Switched Rack PDU AP7920', vendor: 'APC', category: 'power', renderType: 'pdu', uSize: 1, frontBack: 'back' },
  { id: 'apc-metered-pdu-ap7821', name: 'Metered Rack PDU AP7821', vendor: 'APC', category: 'power', renderType: 'pdu', uSize: 1, frontBack: 'back' },
  { id: 'apc-basic-pdu-ap9567', name: 'Basic Rack PDU AP9567', vendor: 'APC', category: 'power', renderType: 'pdu', uSize: 1, frontBack: 'back' },
  { id: 'tripplite-smartpro-1500', name: 'SmartPro 1500VA', vendor: 'Tripp Lite', category: 'power', renderType: 'ups', uSize: 2, frontBack: 'front' },
  { id: 'cyberpower-pdu15swhviec', name: 'PDU15SWHVIEC', vendor: 'CyberPower', category: 'power', renderType: 'pdu', uSize: 1, frontBack: 'back' },
  { id: 'eaton-9px-3000-rack', name: '9PX 3000 Rack UPS', vendor: 'Eaton', category: 'power', renderType: 'ups', uSize: 3, frontBack: 'front' },
  { id: 'vertiv-mph2-pdu', name: 'Vertiv MPH2 PDU', vendor: 'Vertiv', category: 'power', renderType: 'pdu', uSize: 1, frontBack: 'back' },

  // --- Patch & Cable (6) ------------------------------------------------------
  { id: 'patch-cat6-24port', name: 'CAT6 24-Port Patch Panel', vendor: 'Generic', category: 'patch-cable', renderType: 'patch-panel', uSize: 1, frontBack: 'front' },
  { id: 'patch-cat6-48port', name: 'CAT6 48-Port Patch Panel', vendor: 'Generic', category: 'patch-cable', renderType: 'patch-panel', uSize: 2, frontBack: 'front' },
  { id: 'patch-fiber-lc-24port', name: 'Fiber LC Patch Panel 24-Port', vendor: 'Generic', category: 'patch-cable', renderType: 'patch-panel', uSize: 1, frontBack: 'front' },
  { id: 'cable-manager-1u-bar', name: '1U Cable Management Bar', vendor: 'Generic', category: 'patch-cable', renderType: 'cable-manager', uSize: 1, frontBack: 'back' },
  { id: 'cable-manager-2u-panel', name: '2U Cable Management Panel', vendor: 'Generic', category: 'patch-cable', renderType: 'cable-manager', uSize: 2, frontBack: 'back' },
  { id: 'cable-organizer-tray', name: 'Velcro Cable Organizer Tray', vendor: 'Generic', category: 'patch-cable', renderType: 'cable-manager', uSize: 1, frontBack: 'back' },
];
