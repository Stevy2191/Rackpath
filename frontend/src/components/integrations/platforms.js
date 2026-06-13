import { Wifi, Activity, BarChart3, Database, Radio, Code2 } from 'lucide-react';

export const PLATFORMS = [
  { id: 'unifi', label: 'UniFi', icon: Wifi },
  { id: 'zabbix', label: 'Zabbix', icon: Activity },
  { id: 'librenms', label: 'LibreNMS', icon: BarChart3 },
  { id: 'netbox', label: 'NetBox', icon: Database },
  { id: 'snmp', label: 'SNMP', icon: Radio },
  { id: 'custom', label: 'Custom REST API', icon: Code2 },
];

export function platformInfo(id) {
  return PLATFORMS.find((p) => p.id === id) || { id, label: id || 'Unknown', icon: Database };
}
