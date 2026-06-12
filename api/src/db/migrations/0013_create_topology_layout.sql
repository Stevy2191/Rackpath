-- Safety-net migration for topology_layout, which historically only existed in
-- db/init.sql (the base schema applied before migrations run). Creating it here
-- with IF NOT EXISTS is a no-op on every existing deployment but ensures the
-- table every topology route depends on is represented in the migration set.
CREATE TABLE IF NOT EXISTS topology_layout (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id  INT UNSIGNED        NOT NULL DEFAULT 1,
    device_id   INT UNSIGNED        NOT NULL,
    x           DOUBLE              NOT NULL DEFAULT 0,
    y           DOUBLE              NOT NULL DEFAULT 0,
    width       DOUBLE              NOT NULL DEFAULT 120,
    height      DOUBLE              NOT NULL DEFAULT 80,
    created_at  TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_topology_layout_device
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    CONSTRAINT fk_topology_layout_project
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    UNIQUE KEY uq_topology_layout_device (device_id),
    KEY idx_topology_layout_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
