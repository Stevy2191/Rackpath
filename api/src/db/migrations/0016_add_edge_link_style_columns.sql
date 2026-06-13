-- Per-edge link styling and label visibility, set from the link properties
-- panel on the topology canvas.
ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS source_label_visible BOOLEAN NOT NULL DEFAULT TRUE AFTER target_interface;
ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS target_label_visible BOOLEAN NOT NULL DEFAULT TRUE AFTER source_label_visible;
ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS label_color VARCHAR(20) NULL AFTER label;
ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS line_style VARCHAR(20) NOT NULL DEFAULT 'default' AFTER cable_type;
ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS animate BOOLEAN NOT NULL DEFAULT FALSE AFTER line_style;
ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS snapping BOOLEAN NOT NULL DEFAULT FALSE AFTER animate;
