import {
  Server, Network, Shield, HardDrive, Zap, Plug, Cable, Monitor, Wifi, Box, Minus,
  ServerCog, Scale, Archive, Shuffle, CircleDot, Terminal, MonitorCog, Volume2,
  PlayCircle, MonitorPlay, Inbox, PackageOpen, ArrowLeftRight,
} from 'lucide-react';

export const CATEGORY_CONFIG = {
  switch:                 '#2563EB',
  firewall:               '#E63946',
  server:                 '#0284C7',
  'blade-chassis':        '#0369A1',
  storage:                '#16A34A',
  'tape-library':         '#15803D',
  'san-switch':           '#1D4ED8',
  ups:                    '#EA580C',
  pdu:                    '#D97706',
  'pdu-vertical':         '#D97706',
  ats:                    '#C2410C',
  'patch-panel':          '#7C3AED',
  'patch-panel-copper':   '#7C3AED',
  'patch-panel-fiber':    '#9333EA',
  'cable-manager':        '#6D28D9',
  keystone:               '#6D28D9',
  blank:                  '#374151',
  kvm:                    '#0891B2',
  'console-server':       '#0E7490',
  oob:                    '#155E75',
  ap:                     '#059669',
  'wireless-controller':  '#059669',
  'load-balancer':        '#0D9488',
  amplifier:              '#BE185D',
  'media-player':         '#BE185D',
  'display-controller':   '#9D174D',
  shelf:                  '#4B5563',
  drawer:                 '#4B5563',
  other:                  '#0D9488',
};

export const CATEGORY_ICONS = {
  switch:                 Network,
  firewall:               Shield,
  server:                 Server,
  'blade-chassis':        ServerCog,
  storage:                HardDrive,
  'tape-library':         Archive,
  'san-switch':           Shuffle,
  ups:                    Zap,
  pdu:                    Plug,
  'pdu-vertical':         Plug,
  ats:                    ArrowLeftRight,
  'patch-panel':          Cable,
  'patch-panel-copper':   Cable,
  'patch-panel-fiber':    Cable,
  'cable-manager':        Cable,
  keystone:               CircleDot,
  blank:                  Minus,
  kvm:                    Monitor,
  'console-server':       Terminal,
  oob:                    MonitorCog,
  ap:                     Wifi,
  'wireless-controller':  Wifi,
  'load-balancer':        Scale,
  amplifier:              Volume2,
  'media-player':         PlayCircle,
  'display-controller':   MonitorPlay,
  shelf:                  Inbox,
  drawer:                 PackageOpen,
  other:                  Box,
};

const KEYWORD_RULES = [
  // Checked before the generic /switch/i rule below, so "Automatic
  // Transfer Switch"/"ATS" doesn't get misclassified as a network switch.
  [/\bats\b|transfer switch/i, 'ats'],
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

// Returns { color, Icon } for the given slot/entry. Pass any object with
// custom_type, device_type, or item_type set.
export function getCategoryStyle(slot) {
  const type = resolveRenderType(slot);
  return {
    color: CATEGORY_CONFIG[type] || CATEGORY_CONFIG.other,
    Icon: CATEGORY_ICONS[type] || Box,
  };
}
