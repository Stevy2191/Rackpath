const pool = require('./pool');

// Idempotent table creation for deployments whose database volume predates
// these tables. db/init.sql only runs against a fresh MariaDB volume, so
// existing installs need these applied at API startup as well.
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS topology_edges (
      id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      source_device_id    INT UNSIGNED        NOT NULL,
      target_device_id    INT UNSIGNED        NOT NULL,
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
];

async function migrate() {
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }
}

module.exports = { migrate };
