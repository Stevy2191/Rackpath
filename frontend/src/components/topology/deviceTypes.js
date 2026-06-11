// Preset device types shown in the Manual picker tab, and used to classify
// devices (manual or discovered) for icons/accent colors throughout the
// topology canvas.
export const DEVICE_TYPES = {
  router: { label: 'Router', icon: '🌐', color: '#2563eb' },
  switch: { label: 'Switch', icon: '🔀', color: '#d97706' },
  firewall: { label: 'Firewall', icon: '🛡️', color: '#dc2626' },
  server: { label: 'Server', icon: '🖥️', color: '#16a34a' },
  ap: { label: 'Access Point', icon: '📡', color: '#7c3aed' },
  endpoint: { label: 'Endpoint', icon: '💻', color: '#0891b2' },
  nas: { label: 'NAS', icon: '💾', color: '#65a30d' },
  printer: { label: 'Printer', icon: '🖨️', color: '#db2777' },
  unknown: { label: 'Unknown', icon: '❔', color: '#6b7280' },
};

export function classifyDevice(type) {
  const t = (type || '').toLowerCase().trim();
  if (DEVICE_TYPES[t]) return t;

  if (t.includes('firewall')) return 'firewall';
  if (t.includes('router') || t.includes('gateway')) return 'router';
  if (t.includes('switch')) return 'switch';
  if (t.includes('access point') || t.includes('wap') || t.includes('wifi') || t.includes('wireless')) return 'ap';
  if (t.includes('nas') || t.includes('storage')) return 'nas';
  if (t.includes('printer')) return 'printer';
  if (t.includes('server') || t.includes('linux') || t.includes('windows') || t.includes('unix') || t.includes('host')) return 'server';
  if (t.includes('endpoint') || t.includes('workstation') || t.includes('desktop') || t.includes('laptop') || t.includes('pc')) return 'endpoint';

  return 'unknown';
}
