import {
  Router as RouterIcon,
  GitBranch,
  Shield,
  Shuffle,
  Wifi,
  Radio,
  Server as ServerIcon,
  Database,
  HardDrive,
  Monitor,
  Laptop,
  Printer,
  Phone,
  HelpCircle,
  Cloud,
  Globe,
  Puzzle,
} from 'lucide-react';

// Preset device types shown in the Manual picker tab, and used to classify
// devices (manual or discovered) for icons/accent colors throughout the
// topology canvas. `icon` is a lucide-react component.
export const DEVICE_TYPES = {
  router: { label: 'Router', icon: RouterIcon, color: '#2563eb' },
  switch: { label: 'Switch', icon: GitBranch, color: '#d97706' },
  firewall: { label: 'Firewall', icon: Shield, color: '#dc2626' },
  loadbalancer: { label: 'Load Balancer', icon: Shuffle, color: '#9333ea' },
  ap: { label: 'Access Point', icon: Wifi, color: '#7c3aed' },
  wireless_controller: { label: 'Wireless Controller', icon: Radio, color: '#0ea5e9' },
  server: { label: 'Server', icon: ServerIcon, color: '#16a34a' },
  nas: { label: 'NAS', icon: Database, color: '#65a30d' },
  san: { label: 'SAN', icon: HardDrive, color: '#0d9488' },
  endpoint: { label: 'Endpoint / PC', icon: Monitor, color: '#0891b2' },
  laptop: { label: 'Laptop', icon: Laptop, color: '#0284c7' },
  printer: { label: 'Printer', icon: Printer, color: '#db2777' },
  ip_phone: { label: 'IP Phone', icon: Phone, color: '#ea580c' },
  unknown: { label: 'Unknown', icon: HelpCircle, color: '#6b7280' },
  cloud: { label: 'Cloud', icon: Cloud, color: '#64748b' },
  internet: { label: 'Internet', icon: Globe, color: '#0369a1' },
  custom: { label: 'Custom', icon: Puzzle, color: '#6b7280' },
};

// Visio-style grouping for the device picker. Order here drives the order
// the collapsible categories are rendered in.
export const DEVICE_CATEGORIES = [
  { name: 'Network Infrastructure', types: ['router', 'switch', 'firewall', 'loadbalancer'] },
  { name: 'Wireless', types: ['ap', 'wireless_controller'] },
  { name: 'Servers & Storage', types: ['server', 'nas', 'san'] },
  { name: 'End Devices', types: ['endpoint', 'laptop', 'printer', 'ip_phone'] },
  { name: 'Other', types: ['unknown', 'cloud', 'internet'] },
];

const CUSTOM_TYPE_PREFIX = 'custom:';

// Custom uploaded icons are stored as a device "type" of `custom:<filename>`
// so the canvas can render them without any extra lookups.
export function customType(filename) {
  return `${CUSTOM_TYPE_PREFIX}${filename}`;
}

export function isCustomType(type) {
  return typeof type === 'string' && type.startsWith(CUSTOM_TYPE_PREFIX);
}

export function customIconFilename(type) {
  return type.slice(CUSTOM_TYPE_PREFIX.length);
}

export function customIconUrl(filename) {
  const base = process.env.REACT_APP_API_BASE_URL || '/api';
  return `${base}/topology/icons/file/${filename}`;
}

export function classifyDevice(type) {
  const t = (type || '').toLowerCase().trim();
  if (isCustomType(t)) return 'custom';
  if (DEVICE_TYPES[t]) return t;

  if (t.includes('firewall')) return 'firewall';
  if (t.includes('load balancer') || t.includes('loadbalancer') || t === 'lb') return 'loadbalancer';
  if (t.includes('router') || t.includes('gateway')) return 'router';
  if (t.includes('switch')) return 'switch';
  if (t.includes('wireless controller') || t.includes('wlc')) return 'wireless_controller';
  if (t.includes('access point') || t.includes('wap') || t.includes('wifi') || t.includes('wireless')) return 'ap';
  if (t.includes('san')) return 'san';
  if (t.includes('nas') || t.includes('storage')) return 'nas';
  if (t.includes('printer')) return 'printer';
  if (t.includes('phone')) return 'ip_phone';
  if (t.includes('laptop') || t.includes('notebook')) return 'laptop';
  if (t.includes('cloud')) return 'cloud';
  if (t.includes('internet') || t.includes('wan')) return 'internet';
  if (t.includes('server') || t.includes('linux') || t.includes('windows') || t.includes('unix') || t.includes('host')) return 'server';
  if (t.includes('endpoint') || t.includes('workstation') || t.includes('desktop') || t.includes('pc')) return 'endpoint';

  return 'unknown';
}
