CREATE TABLE IF NOT EXISTS projects (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(255)        NOT NULL,
    description TEXT                NULL,
    created_at  TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO projects (id, name, description)
VALUES (1, 'Default Project', 'Default project')
ON DUPLICATE KEY UPDATE id = id;

-- Add project_id to every project-scoped table. Existing rows default to the
-- Default Project (id 1).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS project_id INT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE ports ADD COLUMN IF NOT EXISTS project_id INT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE racks ADD COLUMN IF NOT EXISTS project_id INT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE rack_slots ADD COLUMN IF NOT EXISTS project_id INT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE topology_layout ADD COLUMN IF NOT EXISTS project_id INT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS project_id INT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE topology_zones ADD COLUMN IF NOT EXISTS project_id INT UNSIGNED NOT NULL DEFAULT 1;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS project_id INT UNSIGNED NOT NULL DEFAULT 1;

-- Index project_id for the lookups every endpoint now does.
ALTER TABLE devices ADD INDEX IF NOT EXISTS idx_devices_project (project_id);
ALTER TABLE ports ADD INDEX IF NOT EXISTS idx_ports_project (project_id);
ALTER TABLE racks ADD INDEX IF NOT EXISTS idx_racks_project (project_id);
ALTER TABLE rack_slots ADD INDEX IF NOT EXISTS idx_rack_slots_project (project_id);
ALTER TABLE topology_layout ADD INDEX IF NOT EXISTS idx_topology_layout_project (project_id);
ALTER TABLE topology_edges ADD INDEX IF NOT EXISTS idx_topology_edges_project (project_id);
ALTER TABLE topology_zones ADD INDEX IF NOT EXISTS idx_topology_zones_project (project_id);
ALTER TABLE scan_jobs ADD INDEX IF NOT EXISTS idx_scan_jobs_project (project_id);

-- Make device IP/MAC unique per project rather than globally, so the same
-- address can exist in different projects.
ALTER TABLE devices DROP INDEX IF EXISTS uq_devices_ip;
ALTER TABLE devices DROP INDEX IF EXISTS uq_devices_mac;
ALTER TABLE devices ADD UNIQUE INDEX IF NOT EXISTS uq_devices_project_ip (project_id, ip);
ALTER TABLE devices ADD UNIQUE INDEX IF NOT EXISTS uq_devices_project_mac (project_id, mac);
