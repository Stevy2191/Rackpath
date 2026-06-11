-- ---------------------------------------------------------------------------
-- Rackpath schema
-- Executed automatically by the MariaDB container on first start
-- (mounted into /docker-entrypoint-initdb.d/)
-- ---------------------------------------------------------------------------

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id                      INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username                VARCHAR(64)         NOT NULL,
    password_hash           VARCHAR(255)        NOT NULL,
    must_change_password    TINYINT(1)          NOT NULL DEFAULT 1,
    created_at              TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
    id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    hostname        VARCHAR(255)        NULL,
    ip              VARCHAR(45)         NULL,
    mac             VARCHAR(17)         NULL,
    type            VARCHAR(64)         NULL,
    snmp_community  VARCHAR(128)        NULL,
    notes           TEXT                NULL,
    created_at      TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_devices_ip (ip),
    UNIQUE KEY uq_devices_mac (mac)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- ports
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ports (
    id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    device_id           INT UNSIGNED        NOT NULL,
    port_name           VARCHAR(128)        NULL,
    port_number         INT                 NULL,
    cable_type          VARCHAR(64)         NULL,
    connected_device_id INT UNSIGNED        NULL,
    connected_port_id   INT UNSIGNED        NULL,
    speed               VARCHAR(32)         NULL,
    created_at          TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_ports_device
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    CONSTRAINT fk_ports_connected_device
        FOREIGN KEY (connected_device_id) REFERENCES devices(id) ON DELETE SET NULL,
    CONSTRAINT fk_ports_connected_port
        FOREIGN KEY (connected_port_id) REFERENCES ports(id) ON DELETE SET NULL,
    KEY idx_ports_device_id (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- racks
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS racks (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(255)        NOT NULL,
    location    VARCHAR(255)        NULL,
    u_height    INT UNSIGNED        NOT NULL DEFAULT 42,
    notes       TEXT                NULL,
    created_at  TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- rack_slots
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rack_slots (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    rack_id     INT UNSIGNED        NOT NULL,
    device_id   INT UNSIGNED        NULL,
    u_position  INT UNSIGNED        NOT NULL,
    u_size      INT UNSIGNED        NOT NULL DEFAULT 1,
    created_at  TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_rack_slots_rack
        FOREIGN KEY (rack_id) REFERENCES racks(id) ON DELETE CASCADE,
    CONSTRAINT fk_rack_slots_device
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL,
    KEY idx_rack_slots_rack_id (rack_id),
    KEY idx_rack_slots_device_id (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- topology_layout
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topology_layout (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    device_id   INT UNSIGNED        NOT NULL,
    x           DOUBLE              NOT NULL DEFAULT 0,
    y           DOUBLE              NOT NULL DEFAULT 0,
    created_at  TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_topology_layout_device
        FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
    UNIQUE KEY uq_topology_layout_device (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- scan_jobs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scan_jobs (
    id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    target_subnet   VARCHAR(64)         NOT NULL,
    status          ENUM('pending', 'running', 'completed', 'failed')
                        NOT NULL DEFAULT 'pending',
    progress_current INT UNSIGNED       NULL,
    progress_total  INT UNSIGNED        NULL,
    started_at      TIMESTAMP           NULL,
    completed_at    TIMESTAMP           NULL,
    results         JSON                NULL,
    created_at      TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_scan_jobs_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Upgrade path for existing deployments: db/init.sql is safe to re-run, and
-- these add the progress columns to a scan_jobs table created before they
-- existed (no-op if the table was just created above with them already).
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS progress_current INT UNSIGNED NULL AFTER status;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS progress_total INT UNSIGNED NULL AFTER progress_current;

-- ---------------------------------------------------------------------------
-- topology_edges
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topology_edges (
    id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    source_device_id    INT UNSIGNED        NOT NULL,
    target_device_id    INT UNSIGNED        NOT NULL,
    label               VARCHAR(128)        NULL,
    speed               VARCHAR(32)         NULL,
    cable_type          VARCHAR(64)         NULL,
    vlan                VARCHAR(32)         NULL,
    created_at          TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_topology_edges_source
        FOREIGN KEY (source_device_id) REFERENCES devices(id) ON DELETE CASCADE,
    CONSTRAINT fk_topology_edges_target
        FOREIGN KEY (target_device_id) REFERENCES devices(id) ON DELETE CASCADE,
    KEY idx_topology_edges_source (source_device_id),
    KEY idx_topology_edges_target (target_device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- topology_zones
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS topology_zones (
    id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(255)            NOT NULL,
    border_style    ENUM('solid', 'dotted') NOT NULL DEFAULT 'solid',
    color           VARCHAR(32)             NOT NULL DEFAULT 'blue',
    x               DOUBLE                  NOT NULL DEFAULT 0,
    y               DOUBLE                  NOT NULL DEFAULT 0,
    width           DOUBLE                  NOT NULL DEFAULT 300,
    height          DOUBLE                  NOT NULL DEFAULT 200,
    created_at      TIMESTAMP               NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
