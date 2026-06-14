-- Tag assignments for cameras (project_cameras), mirroring
-- device_tag_assignments so the project's device_tags can also be applied
-- to camera rows shown in the All Devices view.
CREATE TABLE IF NOT EXISTS camera_tag_assignments (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    camera_id   INT UNSIGNED NOT NULL,
    tag_id      INT UNSIGNED NOT NULL,
    CONSTRAINT fk_camera_tag_assignments_camera
        FOREIGN KEY (camera_id) REFERENCES project_cameras(id) ON DELETE CASCADE,
    CONSTRAINT fk_camera_tag_assignments_tag
        FOREIGN KEY (tag_id) REFERENCES device_tags(id) ON DELETE CASCADE,
    UNIQUE KEY uq_camera_tag_assignment (camera_id, tag_id),
    KEY idx_camera_tag_assignments_tag (tag_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Clear any "hasPackageCamera: true/false" text that earlier sync code wrote
-- into location_notes; this field is user-editable only and should be blank
-- until a user sets it.
UPDATE project_cameras SET location_notes = NULL WHERE location_notes LIKE '%hasPackageCamera%';
