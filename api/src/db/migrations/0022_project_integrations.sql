-- Generic API integration framework: per-project connections to external
-- monitoring/IPAM platforms (UniFi, Zabbix, LibreNMS, NetBox, SNMP, custom
-- REST). Credentials are stored via AES_ENCRYPT/TO_BASE64 using the
-- RACKPATH_JWT_SECRET server secret, never in plaintext. `config` holds
-- platform-specific extras (e.g. the custom adapter's field mappings).
CREATE TABLE IF NOT EXISTS project_integrations (
    id                      INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id              INT UNSIGNED NOT NULL,
    name                    VARCHAR(100) NOT NULL,
    platform                VARCHAR(50) NOT NULL,
    base_url                VARCHAR(255) NOT NULL,
    username                VARCHAR(100) NULL,
    password                VARCHAR(500) NULL,
    api_key                 VARCHAR(500) NULL,
    verify_ssl              BOOLEAN NOT NULL DEFAULT TRUE,
    auto_sync               BOOLEAN NOT NULL DEFAULT FALSE,
    sync_interval_minutes   INT NOT NULL DEFAULT 60,
    last_synced_at          TIMESTAMP NULL DEFAULT NULL,
    status                  VARCHAR(20) NOT NULL DEFAULT 'unconfigured',
    status_message          VARCHAR(255) NULL,
    config                  JSON NULL,
    created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_project_integrations_project
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    KEY idx_project_integrations_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- History of sync runs for each integration, shown in the Integrations UI.
CREATE TABLE IF NOT EXISTS integration_sync_log (
    id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    integration_id      INT UNSIGNED NOT NULL,
    synced_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    devices_imported    INT NOT NULL DEFAULT 0,
    vlans_imported      INT NOT NULL DEFAULT 0,
    status              VARCHAR(20) NOT NULL,
    message             TEXT NULL,
    CONSTRAINT fk_integration_sync_log_integration
        FOREIGN KEY (integration_id) REFERENCES project_integrations(id) ON DELETE CASCADE,
    KEY idx_integration_sync_log_integration (integration_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tag devices imported by a sync with the integration they came from, so the
-- Device Inventory can show a source badge.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS source_integration_id INT UNSIGNED NULL AFTER text_color;
ALTER TABLE devices
    ADD CONSTRAINT fk_devices_source_integration FOREIGN KEY IF NOT EXISTS (source_integration_id)
    REFERENCES project_integrations(id) ON DELETE SET NULL;

-- Up/down status reported by monitoring-platform adapters (Zabbix, LibreNMS).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS status VARCHAR(20) NULL AFTER source_integration_id;
