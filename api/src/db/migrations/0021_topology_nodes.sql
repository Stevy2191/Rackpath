-- topology_nodes becomes the canonical canvas-node entity. device_id is
-- nullable: set -> node is linked to a Device Inventory record (label/type
-- etc. come from devices); NULL -> standalone documentation-only node using
-- this row's own label/type/icon_color/text_color.
CREATE TABLE IF NOT EXISTS topology_nodes (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id  INT UNSIGNED        NOT NULL DEFAULT 1,
    device_id   INT UNSIGNED        NULL,
    label       VARCHAR(255)        NULL,
    type        VARCHAR(64)         NULL,
    icon_color  VARCHAR(16)         NULL,
    text_color  VARCHAR(16)         NULL,
    x           DOUBLE              NOT NULL DEFAULT 0,
    y           DOUBLE              NOT NULL DEFAULT 0,
    width       DOUBLE              NOT NULL DEFAULT 120,
    height      DOUBLE              NOT NULL DEFAULT 80,
    created_at  TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_topology_nodes_device
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    CONSTRAINT fk_topology_nodes_project
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    UNIQUE KEY uq_topology_nodes_device (device_id),
    KEY idx_topology_nodes_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Carry over existing canvas placements as device-linked nodes.
INSERT INTO topology_nodes (project_id, device_id, x, y, width, height, created_at, updated_at)
SELECT tl.project_id, tl.device_id, tl.x, tl.y, tl.width, tl.height, tl.created_at, tl.updated_at
FROM topology_layout tl
WHERE NOT EXISTS (
    SELECT 1 FROM topology_nodes tn WHERE tn.device_id = tl.device_id
);

-- Edges gain node-based endpoints so standalone nodes can be connected.
ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS source_node_id INT UNSIGNED NULL AFTER source_device_id;
ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS target_node_id INT UNSIGNED NULL AFTER target_device_id;
ALTER TABLE topology_edges ADD INDEX IF NOT EXISTS idx_topology_edges_source_node (source_node_id);
ALTER TABLE topology_edges ADD INDEX IF NOT EXISTS idx_topology_edges_target_node (target_node_id);

-- Existing device_id endpoints become optional going forward.
ALTER TABLE topology_edges MODIFY COLUMN source_device_id INT UNSIGNED NULL;
ALTER TABLE topology_edges MODIFY COLUMN target_device_id INT UNSIGNED NULL;

-- Backfill node ids for existing edges from the devices they reference.
UPDATE topology_edges e
JOIN topology_nodes n ON n.device_id = e.source_device_id
SET e.source_node_id = n.id
WHERE e.source_node_id IS NULL;

UPDATE topology_edges e
JOIN topology_nodes n ON n.device_id = e.target_device_id
SET e.target_node_id = n.id
WHERE e.target_node_id IS NULL;

-- Device Inventory: richer asset-tracking fields.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS make VARCHAR(100) NULL AFTER type;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS model VARCHAR(100) NULL AFTER make;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS serial_number VARCHAR(100) NULL AFTER model;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS purchase_date DATE NULL AFTER serial_number;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS warranty_expiry DATE NULL AFTER purchase_date;
