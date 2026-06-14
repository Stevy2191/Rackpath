-- Device organisation: free-form tags and a physical location field for the
-- Device Inventory page.
CREATE TABLE IF NOT EXISTS device_tags (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id  INT UNSIGNED NOT NULL,
    name        VARCHAR(100) NOT NULL,
    color       VARCHAR(20) NOT NULL DEFAULT '#4A90E2',
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_device_tags_project
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    KEY idx_device_tags_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS device_tag_assignments (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    device_id   INT UNSIGNED NOT NULL,
    tag_id      INT UNSIGNED NOT NULL,
    CONSTRAINT fk_device_tag_assignments_device
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    CONSTRAINT fk_device_tag_assignments_tag
        FOREIGN KEY (tag_id) REFERENCES device_tags(id) ON DELETE CASCADE,
    UNIQUE KEY uq_device_tag_assignment (device_id, tag_id),
    KEY idx_device_tag_assignments_tag (tag_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE devices ADD COLUMN IF NOT EXISTS location VARCHAR(100) NULL DEFAULT NULL AFTER notes;
