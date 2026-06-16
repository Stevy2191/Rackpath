// Flat faceplate color map and render-type resolver.
// Rendering logic lives in DeviceFacePlate.js (flat block + icon + name).

export const CATEGORY_CONFIG = {
  switch:           '#1a5276',
  firewall:         '#7b241c',
  server:           '#1f4e79',
  storage:          '#145a32',
  ups:              '#6e4f02',
  pdu:              '#2c3e50',
  'patch-panel':    '#212121',
  'cable-manager':  '#3b1f5a',
  blank:            '#1c1c1c',
  kvm:              '#4a235a',
  ap:               '#0a3d2d',
  other:            '#1e2a3a',
};

const KEYWORD_RULES = [
  [/firewall|fortigate|palo ?alto|fortinet|udm|router/i, 'firewall'],
  [/switch/i, 'switch'],
  [/poweredge|proliant|thinksystem|superserver|^server$/i, 'server'],
  [/storage|^nas$|rackstation|powervault|netapp/i, 'storage'],
  [/ups|battery/i, 'ups'],
  [/pdu|power distribution/i, 'pdu'],
  [/patch/i, 'patch-panel'],
  [/cable/i, 'cable-manager'],
  [/blank/i, 'blank'],
  [/kvm/i, 'kvm'],
  [/access point|wireless|^ap$/i, 'ap'],
];

export function resolveRenderType(slot) {
  const raw = slot.custom_type || slot.device_type || slot.item_type || '';
  const lower = String(raw).toLowerCase();
  if (CATEGORY_CONFIG[lower]) return lower;
  for (const [re, type] of KEYWORD_RULES) {
    if (re.test(raw)) return type;
  }
  if (slot.item_type === 'patch-panel') return 'patch-panel';
  if (slot.item_type === 'blank') return 'blank';
  if (slot.item_type === 'cable-manager') return 'cable-manager';
  return 'other';
}
