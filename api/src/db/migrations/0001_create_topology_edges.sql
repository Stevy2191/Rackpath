CREATE TABLE IF NOT EXISTS topology_edges (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
