#!/usr/bin/env node
// Removes orphaned rows in project-scoped tables whose project_id no longer
// exists in the projects table. Safe to run at any time; it only removes data
// that would have been cascade-deleted had the FK been enforced.
//
// Usage: node api/src/db/cleanup.js [--dry-run]
//
// --dry-run  Print what would be deleted without actually deleting it.

const pool = require('./pool');

const DRY_RUN = process.argv.includes('--dry-run');

// Tables that have a direct project_id column referencing projects(id).
const DIRECT_TABLES = [
  'topology_connection_points',
  'topology_node_interfaces',
  'topology_edges',
  'topology_nodes',
  'topology_zones',
  'topology_shapes',
  'topology_labels',
  'topology_layout',
  'scan_jobs',
  'project_integrations',
  'project_cameras',
  'device_tags',
  'project_access_devices',
  'rack_slots',
  'rack_custom_devices',
  'racks',
  'project_credential_macros',
  'project_vlans',
  'project_activity_log',
  'devices',
];

async function run() {
  const [projects] = await pool.query('SELECT id FROM projects');
  const projectIds = projects.map((p) => p.id);

  if (projectIds.length === 0) {
    console.log('No projects in DB — nothing to do.');
    await pool.end();
    return;
  }

  console.log(`Active projects: ${projectIds.join(', ')}`);

  for (const table of DIRECT_TABLES) {
    try {
      const placeholders = projectIds.map(() => '?').join(', ');
      const [countRows] = await pool.query(
        `SELECT COUNT(*) AS cnt FROM ${table} WHERE project_id NOT IN (${placeholders})`,
        projectIds
      );
      const { cnt } = countRows[0];

      if (Number(cnt) === 0) {
        console.log(`  ${table}: clean`);
        continue;
      }

      if (DRY_RUN) {
        console.log(`  ${table}: would delete ${cnt} orphaned row(s) (dry run)`);
      } else {
        await pool.query(
          `DELETE FROM ${table} WHERE project_id NOT IN (${placeholders})`,
          projectIds
        );
        console.log(`  ${table}: deleted ${cnt} orphaned row(s)`);
      }
    } catch (err) {
      console.warn(`  ${table}: skipped — ${err.message}`);
    }
  }

  console.log(DRY_RUN ? '\nDry run complete — no changes made.' : '\nCleanup complete.');
  await pool.end();
}

run().catch((err) => {
  console.error('Cleanup failed:', err.message);
  process.exit(1);
});
