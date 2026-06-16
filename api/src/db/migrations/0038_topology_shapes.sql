CREATE TABLE IF NOT EXISTS topology_shapes (
    id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id   INT UNSIGNED NOT NULL,
    shape_type   VARCHAR(20) NOT NULL DEFAULT 'rect',
    x            FLOAT NOT NULL DEFAULT 0,
    y            FLOAT NOT NULL DEFAULT 0,
    width        FLOAT NOT NULL DEFAULT 160,
    height       FLOAT NOT NULL DEFAULT 100,
    fill_color   VARCHAR(50) NOT NULL DEFAULT '#3b82f620',
    border_color VARCHAR(50) NOT NULL DEFAULT '#3b82f6',
    label        VARCHAR(255) NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_topology_shapes_project (project_id),
    CONSTRAINT fk_topology_shapes_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
