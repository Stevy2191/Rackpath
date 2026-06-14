-- Reusable per-project credential profiles (SNMP/SSH/Telnet/HTTP(S)) that can
-- be assigned to devices, e.g. "Default SNMP v2", "Core Switches".
CREATE TABLE IF NOT EXISTS project_credential_macros (
    id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id          INT UNSIGNED NOT NULL,
    name                VARCHAR(100) NOT NULL,
    type                VARCHAR(50) NOT NULL,
    community_string    VARCHAR(255) NULL,
    username            VARCHAR(100) NULL,
    password            VARCHAR(255) NULL,
    auth_protocol       VARCHAR(20) NULL,
    auth_password       VARCHAR(255) NULL,
    priv_protocol       VARCHAR(20) NULL,
    priv_password       VARCHAR(255) NULL,
    port                INT NULL,
    notes               VARCHAR(255) NULL,
    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_project_credential_macros_project
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    KEY idx_project_credential_macros_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Assign a credential macro to a device for SNMP scanning etc.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS credential_macro_id INT UNSIGNED NULL AFTER location;
ALTER TABLE devices
    ADD CONSTRAINT fk_devices_credential_macro FOREIGN KEY IF NOT EXISTS (credential_macro_id)
    REFERENCES project_credential_macros(id) ON DELETE SET NULL;
