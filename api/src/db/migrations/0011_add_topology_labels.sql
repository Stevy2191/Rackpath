-- Floating text labels placed directly on the topology canvas (added with the
-- toolbar's Text mode). Project-scoped like every other canvas table.
CREATE TABLE IF NOT EXISTS topology_labels (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id  INT UNSIGNED        NOT NULL DEFAULT 1,
    text        VARCHAR(512)        NOT NULL DEFAULT '',
    x           DOUBLE              NOT NULL DEFAULT 0,
    y           DOUBLE              NOT NULL DEFAULT 0,
    font_size   INT UNSIGNED        NOT NULL DEFAULT 14,
    color       VARCHAR(32)         NULL,
    created_at  TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_topology_labels_project
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    KEY idx_topology_labels_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
