// MariaDB's JSON column type is a LONGTEXT alias under the hood, so mysql2
// returns it as a raw string rather than auto-parsing it like a real MySQL
// JSON column would. Routes must parse it back into a JS array before
// sending it in a response, or summing/checking it server-side.
function parseOutletGroups(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Mutates row.outlet_groups in place (if present) from string to array.
function parseRowOutletGroups(row) {
  if (row && 'outlet_groups' in row) row.outlet_groups = parseOutletGroups(row.outlet_groups);
  return row;
}

function parseRowsOutletGroups(rows) {
  rows.forEach(parseRowOutletGroups);
  return rows;
}

// Total outlet count across all groups, e.g.
// [{type:'NEMA 5-15R',count:6},{type:'C19',count:2}] -> 8.
function sumOutletGroups(value) {
  const groups = parseOutletGroups(value);
  if (!groups) return 0;
  return groups.reduce((sum, g) => sum + (Number(g?.count) || 0), 0);
}

module.exports = { parseOutletGroups, parseRowOutletGroups, parseRowsOutletGroups, sumOutletGroups };
