// Translates raw SNMP ifDescr values into short, readable interface names
// for display in the Topology node properties panel. Applied wherever
// interfaces are discovered/synced (SNMP device scan, plain-SNMP
// integration sync) so names like "Slot: 0 Port: 10 Gigabit - Level" (UniFi
// switches) or "GigabitEthernet0/0/1" (Cisco-style) become "Port10" / "Gi0/0/1".
function translateInterfaceName(ifDescr) {
  if (!ifDescr || typeof ifDescr !== 'string') return ifDescr;
  const raw = ifDescr.trim();

  // UniFi switches: "Slot: 0 Port: 10 Gigabit - Level" -> "Port10"
  const slotPort = raw.match(/^Slot:\s*\d+\s*,?\s*Port:\s*(\d+)/i);
  if (slotPort) return `Port${slotPort[1]}`;

  const gig = raw.match(/^GigabitEthernet(\d+(?:\/\d+)*)$/i);
  if (gig) return `Gi${gig[1]}`;

  const fast = raw.match(/^FastEthernet(\d+(?:\/\d+)*)$/i);
  if (fast) return `Fa${fast[1]}`;

  const tenGig = raw.match(/^TenGigabitEthernet(\d+(?:\/\d+)*)$/i);
  if (tenGig) return `Te${tenGig[1]}`;

  if (/^eth\d+$/i.test(raw)) return raw;

  const loopback = raw.match(/Loopback\s*(\d+)/i);
  if (loopback) return `lo${loopback[1]}`;

  const vlan = raw.match(/vlan\s*(\d+)/i);
  if (vlan) return `vlan${vlan[1]}`;

  if (/mgmt|management/i.test(raw)) return 'mgmt0';

  return raw;
}

module.exports = { translateInterfaceName };
