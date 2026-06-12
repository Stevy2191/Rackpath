-- Ensure topology_node_interfaces exists (table was introduced in
-- 0008_node_styling_and_interfaces.sql; this is a no-op safety net for any
-- database that was upgraded before that migration ran).
CREATE TABLE IF NOT EXISTS topology_node_interfaces (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id  INT UNSIGNED        NOT NULL DEFAULT 1,
    device_id   INT UNSIGNED        NOT NULL,
    name        VARCHAR(128)        NOT NULL,
    description VARCHAR(255)        NULL,
    created_at  TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_topology_node_interfaces_device
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    CONSTRAINT fk_topology_node_interfaces_project
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    KEY idx_topology_node_interfaces_device (device_id),
    KEY idx_topology_node_interfaces_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
