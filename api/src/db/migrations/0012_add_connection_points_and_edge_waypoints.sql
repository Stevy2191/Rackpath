-- Named connection points (port anchors) that can be added to a node at a
-- specific side via the properties panel. Edges can attach to these in
-- addition to the default directional handles.
CREATE TABLE IF NOT EXISTS topology_connection_points (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id  INT UNSIGNED                        NOT NULL DEFAULT 1,
    device_id   INT UNSIGNED                        NOT NULL,
    name        VARCHAR(128)                        NOT NULL DEFAULT '',
    position    ENUM('top','bottom','left','right') NOT NULL DEFAULT 'top',
    created_at  TIMESTAMP                           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_topology_connection_points_device
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    CONSTRAINT fk_topology_connection_points_project
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    KEY idx_topology_connection_points_device (device_id),
    KEY idx_topology_connection_points_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Optional single waypoint used to reroute an edge by dragging its midpoint
-- handle. NULL means the edge takes its default (straight/bezier) path.
ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS waypoint_x DOUBLE NULL AFTER target_handle;
ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS waypoint_y DOUBLE NULL AFTER waypoint_x;
