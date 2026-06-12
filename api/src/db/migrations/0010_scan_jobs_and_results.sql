-- scan_results - one row per host discovered during a scan. Added alongside
-- the SSE-based Scan page redesign; existing deployments need the table
-- created since they predate the migration runner.
CREATE TABLE IF NOT EXISTS scan_results (
    id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    scan_job_id     INT UNSIGNED        NOT NULL,
    status          ENUM('up', 'down')  NOT NULL DEFAULT 'up',
    ip              VARCHAR(45)         NULL,
    hostname        VARCHAR(255)        NULL,
    mac             VARCHAR(17)         NULL,
    mac_vendor      VARCHAR(255)        NULL,
    device_type     VARCHAR(64)         NULL,
    os              VARCHAR(255)        NULL,
    open_ports      JSON                NULL,
    netbios_name    VARCHAR(255)        NULL,
    last_seen       TIMESTAMP           NULL,
    raw             JSON                NULL,
    created_at      TIMESTAMP           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_scan_results_job
        FOREIGN KEY (scan_job_id) REFERENCES scan_jobs(id) ON DELETE CASCADE,
    KEY idx_scan_results_job (scan_job_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- scan_jobs gained a name, live progress columns, and (later) multi-IP
-- target metadata. Add them to a scan_jobs table created before they existed.
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS name VARCHAR(255) NULL AFTER id;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS progress_current INT UNSIGNED NULL AFTER status;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS progress_total INT UNSIGNED NULL AFTER progress_current;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS target_type VARCHAR(16) NULL AFTER target_subnet;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS scan_profile VARCHAR(16) NULL AFTER target_type;

-- Widen target_subnet so a "Multiple IPs" target list fits.
ALTER TABLE scan_jobs MODIFY COLUMN target_subnet VARCHAR(255) NOT NULL;
