-- Adds rack type (visual variant), and turns rack_slots into a generic
-- rack-item model (devices, patch panels, blanks, cable managers) with
-- a front/back/both side assignment for rear-mount items.
ALTER TABLE racks ADD COLUMN IF NOT EXISTS rack_type VARCHAR(32) NOT NULL DEFAULT '4-post' AFTER u_height;
ALTER TABLE rack_slots ADD COLUMN IF NOT EXISTS item_type VARCHAR(32) NOT NULL DEFAULT 'device' AFTER device_id;
ALTER TABLE rack_slots ADD COLUMN IF NOT EXISTS item_label VARCHAR(255) NULL AFTER item_type;
ALTER TABLE rack_slots ADD COLUMN IF NOT EXISTS side VARCHAR(8) NOT NULL DEFAULT 'both' AFTER u_size;
