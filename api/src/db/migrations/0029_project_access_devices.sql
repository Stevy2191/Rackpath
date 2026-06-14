-- UniFi Access (and manually entered) access-control device inventory, scoped
-- per project. Devices discovered via a UniFi Access integration are
-- matched/updated by mac address on each sync; integration_id is nulled if
-- the integration is later removed so manually-added devices and history
-- survive.
CREATE TABLE IF NOT EXISTS project_access_devices (
    id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id          INT UNSIGNED NOT NULL,
    integration_id      INT UNSIGNED NULL,
    name                VARCHAR(255) NOT NULL,
    device_type         VARCHAR(100) NULL,
    model               VARCHAR(100) NULL,
    mac                 VARCHAR(50) NULL,
    ip_address          VARCHAR(50) NULL,
    firmware_version    VARCHAR(50) NULL,
    door_name           VARCHAR(255) NULL,
    location            VARCHAR(255) NULL,
    floor               VARCHAR(100) NULL,
    online              BOOLEAN NOT NULL DEFAULT FALSE,
    door_lock_state     VARCHAR(20) NULL,
    door_open_state     VARCHAR(20) NULL,
    connected_readers   TEXT NULL,
    access_groups       TEXT NULL,
    unlock_schedules    TEXT NULL,
    last_seen           TIMESTAMP NULL DEFAULT NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_project_access_devices_project
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_project_access_devices_integration
        FOREIGN KEY (integration_id) REFERENCES project_integrations(id) ON DELETE SET NULL,
    KEY idx_project_access_devices_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
