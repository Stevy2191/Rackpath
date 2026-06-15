-- front_back: which face of the rack a slot's faceplate renders on. Distinct
-- from `side` (which gates U-collision compatibility for front/back/both
-- placement) -- a PDU can have side='both' (occupies the U on both faces for
-- collision purposes) while front_back='back' (only drawn on the rear view).
ALTER TABLE rack_slots ADD COLUMN IF NOT EXISTS front_back ENUM('front','back') NOT NULL DEFAULT 'front' AFTER side;

-- catalog_id: id of the hardcoded frontend rackCatalog.js entry this slot was
-- placed from (e.g. 'ubiquiti-usw-pro-48'). NULL for inventory-linked devices
-- or legacy rack items.
ALTER TABLE rack_slots ADD COLUMN IF NOT EXISTS catalog_id VARCHAR(100) NULL AFTER custom_type;

-- custom_image_url: relative URL to an uploaded faceplate image for custom
-- devices placed with a photo instead of a generated render.
ALTER TABLE rack_slots ADD COLUMN IF NOT EXISTS custom_image_url VARCHAR(500) NULL AFTER color;

-- vendor: free-text manufacturer name shown in the device block's vendor badge.
ALTER TABLE rack_slots ADD COLUMN IF NOT EXISTS vendor VARCHAR(100) NULL AFTER item_label;

-- rack_custom_devices: project-scoped library of user-defined catalog entries
-- (with optional uploaded faceplate image), shown in the "Custom" tab of the
-- Device Catalog panel.
CREATE TABLE IF NOT EXISTS rack_custom_devices (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id  INT UNSIGNED NOT NULL,
    name        VARCHAR(255) NOT NULL,
    vendor      VARCHAR(100) NULL,
    type        VARCHAR(50) NOT NULL DEFAULT 'other',
    u_size      INT UNSIGNED NOT NULL DEFAULT 1,
    image_url   VARCHAR(500) NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_rack_custom_devices_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    KEY idx_rack_custom_devices_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
