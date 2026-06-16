const VLAN_COLORS = [
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

// Returns the first palette color not currently used by any VLAN in the
// project, cycling through the palette when all are taken.
async function nextVlanColor(db, projectId) {
  const [rows] = await db.query(
    'SELECT color FROM project_vlans WHERE project_id = ?',
    [projectId]
  );
  const used = new Set(rows.map((r) => (r.color || '').toUpperCase()));
  for (const color of VLAN_COLORS) {
    if (!used.has(color.toUpperCase())) return color;
  }
  return VLAN_COLORS[rows.length % VLAN_COLORS.length];
}

module.exports = { VLAN_COLORS, nextVlanColor };
