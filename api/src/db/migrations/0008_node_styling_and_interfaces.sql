-- Per-device icon/text color overrides for the topology canvas.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS icon_color VARCHAR(16) NULL AFTER notes;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS text_color VARCHAR(16) NULL AFTER icon_color;

-- Named interfaces shown in the topology node properties panel and used to
-- label edge connection points.
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

-- Interface labels shown on each end of an edge, near the node it connects to.
ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS source_interface VARCHAR(128) NULL AFTER target_handle;
ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS target_interface VARCHAR(128) NULL AFTER source_interface;
