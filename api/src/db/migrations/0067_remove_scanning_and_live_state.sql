-- Rackpath is documentation software. This removes the features that probed,
-- polled or monitored the network, and the credentials they needed:
--   * network scanning (scan jobs and results)
--   * credential macros (stored SNMP, SSH, Telnet and HTTP logins)
--   * device SNMP polling (last_scanned_at)
--   * live state imported from integrations: camera stream URLs, stream
--     credentials and online status; access-control door lock/open state,
--     access groups, unlock schedules and online status.

-- Foreign keys into the tables being dropped go first.
ALTER TABLE devices DROP FOREIGN KEY IF EXISTS fk_devices_credential_macro;
ALTER TABLE devices DROP COLUMN IF EXISTS credential_macro_id;
ALTER TABLE devices DROP COLUMN IF EXISTS last_scanned_at;

DROP TABLE IF EXISTS scan_results;
DROP TABLE IF EXISTS scan_jobs;
DROP TABLE IF EXISTS project_credential_macros;

ALTER TABLE project_cameras
    DROP COLUMN IF EXISTS rtsp_url,
    DROP COLUMN IF EXISTS rtsps_url,
    DROP COLUMN IF EXISTS rtsps_url_high,
    DROP COLUMN IF EXISTS rtsps_url_medium,
    DROP COLUMN IF EXISTS rtsps_url_low,
    DROP COLUMN IF EXISTS stream_password,
    DROP COLUMN IF EXISTS username,
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS last_seen;

ALTER TABLE project_access_devices
    DROP COLUMN IF EXISTS online,
    DROP COLUMN IF EXISTS door_lock_state,
    DROP COLUMN IF EXISTS door_open_state,
    DROP COLUMN IF EXISTS access_groups,
    DROP COLUMN IF EXISTS unlock_schedules,
    DROP COLUMN IF EXISTS last_seen;
