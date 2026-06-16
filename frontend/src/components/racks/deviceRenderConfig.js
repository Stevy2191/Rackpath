// Flat faceplate color map and render-type resolver.
// Rendering logic lives in DeviceFacePlate.js (flat block + icon + name).

export const CATEGORY_CONFIG = {
  switch:           '#2563EB',
  firewall:         '#E63946',
  server:           '#0284C7',
  storage:          '#16A34A',
  ups:              '#EA580C',
  pdu:              '#D97706',
  'patch-panel':    '#7C3AED',
  'cable-manager':  '#6D28D9',
  blank:            '#374151',
  kvm:              '#0891B2',
  ap:               '#059669',
  other:            '#0D9488',
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
