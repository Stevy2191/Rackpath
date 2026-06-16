export const VLAN_COLORS = [
  '#4A90E2', // blue
  '#E2704A', // orange
  '#4AE270', // green
  '#E24A6B', // red/pink
  '#9B4AE2', // purple
  '#E2C84A', // yellow
  '#4AE2D8', // teal/cyan
  '#E24AB5', // magenta
  '#7BE24A', // lime
  '#4A6BE2', // indigo
  '#E2944A', // amber
  '#4AE2A8', // mint
  '#E24A4A', // coral
  '#4AB5E2', // sky blue
  '#C8E24A', // yellow-green
  '#E27B4A', // burnt orange
];

// Returns the first palette color not already used by any VLAN in the list,
// cycling through the palette if all 16 are taken.
export function nextVlanColor(vlans) {
  const used = new Set((vlans || []).map((v) => (v.color || '').toUpperCase()));
  for (const color of VLAN_COLORS) {
    if (!used.has(color.toUpperCase())) return color;
  }
  return VLAN_COLORS[(vlans || []).length % VLAN_COLORS.length];
}
