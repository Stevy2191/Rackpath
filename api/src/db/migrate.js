const pool = require('./pool');

// Idempotent table creation for deployments whose database volume predates
// these tables. db/init.sql only runs against a fresh MariaDB volume, so
// existing installs need these applied at API startup as well.
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS topology_edges (
      id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      source_device_id    INT UNSIGNED        NOT NULL,
      target_device_id    INT UNSIGNED        NOT NULL,
      source_handle       VARCHAR(16)         NULL,
      target_handle       VARCHAR(16)         NULL,
      label               VARCHAR(128)        NULL,
      speed               VARCHAR(32)         NULL,
      cable_type          VARCHAR(64)         NULL,
      vlan                VARCHAR(32)         NULL,
      created_at          TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_topology_edges_source
          FOREIGN KEY (source_device_id) REFERENCES devices(id) ON DELETE CASCADE,
      CONSTRAINT fk_topology_edges_target
          FOREIGN KEY (target_device_id) REFERENCES devices(id) ON DELETE CASCADE,
      KEY idx_topology_edges_source (source_device_id),
      KEY idx_topology_edges_target (target_device_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS topology_zones (
      id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name            VARCHAR(255)            NOT NULL,
      border_style    ENUM('solid', 'dotted') NOT NULL DEFAULT 'solid',
      color           VARCHAR(32)             NOT NULL DEFAULT 'blue',
      x               DOUBLE                  NOT NULL DEFAULT 0,
      y               DOUBLE                  NOT NULL DEFAULT 0,
      width           DOUBLE                  NOT NULL DEFAULT 300,
      height          DOUBLE                  NOT NULL DEFAULT 200,
      created_at      TIMESTAMP               NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS topology_icons (
      id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name            VARCHAR(255)            NOT NULL,
      filename        VARCHAR(255)            NOT NULL,
      created_at      TIMESTAMP               NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `ALTER TABLE topology_layout ADD COLUMN IF NOT EXISTS width DOUBLE NOT NULL DEFAULT 120 AFTER y`,
  `ALTER TABLE topology_layout ADD COLUMN IF NOT EXISTS height DOUBLE NOT NULL DEFAULT 80 AFTER width`,

  `ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS source_handle VARCHAR(16) NULL AFTER target_device_id`,
  `ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS target_handle VARCHAR(16) NULL AFTER source_handle`,

  // --- Project system ----------------------------------------------------
  `CREATE TABLE IF NOT EXISTS projects (
      id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(255)        NOT NULL,
      description TEXT                NULL,
      created_at  TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `INSERT INTO projects (id, name, description)
   VALUES (1, 'Default Project', 'Default project')
   ON DUPLICATE KEY UPDATE id = id`,

  // Add project_id to every project-scoped table. Existing rows default to the
  // Default Project (id 1).
  `ALTER TABLE devices ADD COLUMN IF NOT EXISTS project_id INT UNSIGNED NOT NULL DEFAULT 1`,
  `ALTER TABLE ports ADD COLUMN IF NOT EXISTS project_id INT UNSIGNED NOT NULL DEFAULT 1`,
  `ALTER TABLE racks ADD COLUMN IF NOT EXISTS project_id INT UNSIGNED NOT NULL DEFAULT 1`,
  `ALTER TABLE rack_slots ADD COLUMN IF NOT EXISTS project_id INT UNSIGNED NOT NULL DEFAULT 1`,
  `ALTER TABLE topology_layout ADD COLUMN IF NOT EXISTS project_id INT UNSIGNED NOT NULL DEFAULT 1`,
  `ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS project_id INT UNSIGNED NOT NULL DEFAULT 1`,
  `ALTER TABLE topology_zones ADD COLUMN IF NOT EXISTS project_id INT UNSIGNED NOT NULL DEFAULT 1`,
  `ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS project_id INT UNSIGNED NOT NULL DEFAULT 1`,

  // Index project_id for the lookups every endpoint now does.
  `ALTER TABLE devices ADD INDEX IF NOT EXISTS idx_devices_project (project_id)`,
  `ALTER TABLE ports ADD INDEX IF NOT EXISTS idx_ports_project (project_id)`,
  `ALTER TABLE racks ADD INDEX IF NOT EXISTS idx_racks_project (project_id)`,
  `ALTER TABLE rack_slots ADD INDEX IF NOT EXISTS idx_rack_slots_project (project_id)`,
  `ALTER TABLE topology_layout ADD INDEX IF NOT EXISTS idx_topology_layout_project (project_id)`,
  `ALTER TABLE topology_edges ADD INDEX IF NOT EXISTS idx_topology_edges_project (project_id)`,
  `ALTER TABLE topology_zones ADD INDEX IF NOT EXISTS idx_topology_zones_project (project_id)`,
  `ALTER TABLE scan_jobs ADD INDEX IF NOT EXISTS idx_scan_jobs_project (project_id)`,

  // Make device IP/MAC unique per project rather than globally, so the same
  // address can exist in different projects.
  `ALTER TABLE devices DROP INDEX IF EXISTS uq_devices_ip`,
  `ALTER TABLE devices DROP INDEX IF EXISTS uq_devices_mac`,
  `ALTER TABLE devices ADD UNIQUE INDEX IF NOT EXISTS uq_devices_project_ip (project_id, ip)`,
  `ALTER TABLE devices ADD UNIQUE INDEX IF NOT EXISTS uq_devices_project_mac (project_id, mac)`,
];

// project_id -> projects(id) foreign keys, added only if not already present.
// Keyed by [table, constraintName].
const PROJECT_FKS = [
  ['devices', 'fk_devices_project'],
  ['ports', 'fk_ports_project'],
  ['racks', 'fk_racks_project'],
  ['rack_slots', 'fk_rack_slots_project'],
  ['topology_layout', 'fk_topology_layout_project'],
  ['topology_edges', 'fk_topology_edges_project'],
  ['topology_zones', 'fk_topology_zones_project'],
  ['scan_jobs', 'fk_scan_jobs_project'],
];

async function constraintExists(table, name) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?
     LIMIT 1`,
    [table, name]
  );
  return rows.length > 0;
}

async function migrate() {
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }

  for (const [table, name] of PROJECT_FKS) {
    if (await constraintExists(table, name)) continue;
    await pool.query(
      `ALTER TABLE ${table} ADD CONSTRAINT ${name}
       FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE`
    );
  }
}

module.exports = { migrate };
