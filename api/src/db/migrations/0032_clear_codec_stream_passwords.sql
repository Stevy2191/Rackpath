-- A prior version of the UniFi Protect adapter incorrectly synced the
-- camera's video codec (e.g. "h264") into stream_password. The adapter no
-- longer syncs stream_password at all (the Manual Recovery code isn't
-- exposed via the Protect API), so clear out any values left over from that
-- bug.
UPDATE project_cameras
SET stream_password = NULL
WHERE stream_password IN ('h264', 'h265', 'hevc', 'mjpeg', 'mpeg4', 'av1');
