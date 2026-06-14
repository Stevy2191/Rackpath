-- Cameras now store separate RTSPS stream URLs for each quality level
-- (high/medium/low) instead of a single rtsps_url. The existing rtsps_url
-- column is left in place but unused going forward; its value is copied into
-- rtsps_url_high so previously-synced high-quality URLs aren't lost.
ALTER TABLE project_cameras ADD COLUMN IF NOT EXISTS rtsps_url_high VARCHAR(500) NULL AFTER rtsps_url;
ALTER TABLE project_cameras ADD COLUMN IF NOT EXISTS rtsps_url_medium VARCHAR(500) NULL AFTER rtsps_url_high;
ALTER TABLE project_cameras ADD COLUMN IF NOT EXISTS rtsps_url_low VARCHAR(500) NULL AFTER rtsps_url_medium;

UPDATE project_cameras SET rtsps_url_high = rtsps_url WHERE rtsps_url_high IS NULL AND rtsps_url IS NOT NULL;
