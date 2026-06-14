-- UniFi Protect (and manually entered) camera inventory, scoped per project.
-- Cameras discovered via a UniFi Protect integration are matched/updated by
-- mac address on each sync; integration_id is nulled if the integration is
-- later removed so manually-added cameras and history survive.
CREATE TABLE IF NOT EXISTS project_cameras (
    id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id          INT UNSIGNED NOT NULL,
    integration_id      INT UNSIGNED NULL,
    name                VARCHAR(255) NOT NULL,
    model               VARCHAR(100) NULL,
    mac                 VARCHAR(50) NULL,
    ip_address          VARCHAR(50) NULL,
    rtsp_url            VARCHAR(500) NULL,
    rtsps_url           VARCHAR(500) NULL,
    stream_password     VARCHAR(255) NULL,
    username            VARCHAR(100) NULL,
    resolution          VARCHAR(50) NULL,
    location_notes      VARCHAR(255) NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'unknown',
    last_seen           TIMESTAMP NULL DEFAULT NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_project_cameras_project
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_project_cameras_integration
        FOREIGN KEY (integration_id) REFERENCES project_integrations(id) ON DELETE SET NULL,
    KEY idx_project_cameras_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
