import { Wifi, Activity, Database, Camera, DoorOpen } from 'lucide-react';

export const PLATFORMS = [
  { id: 'unifi', label: 'UniFi', icon: Wifi },
  { id: 'unifi-protect', label: 'UniFi Protect', icon: Camera },
  { id: 'unifi-access', label: 'UniFi Access', icon: DoorOpen },
  { id: 'zabbix', label: 'Zabbix', icon: Activity },
];

export function platformInfo(id) {
  return PLATFORMS.find((p) => p.id === id) || { id, label: id || 'Unknown', icon: Database };
}
