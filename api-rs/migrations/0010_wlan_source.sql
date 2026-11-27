-- Rackpath v2: Wi-Fi networks from integrations (UniFi Network). Like other
-- imported records, a WLAN remembers the integration that brought it in
-- and the source's id, so re-imports update it, and one that disappears at
-- the source is marked missing, never deleted. (SQLite has no ADD COLUMN IF
-- NOT EXISTS; sqlx records applied migrations, so this runs once.)
ALTER TABLE wlans ADD COLUMN source_integration_id INTEGER REFERENCES integrations (id) ON DELETE SET NULL;
ALTER TABLE wlans ADD COLUMN external_id TEXT;
ALTER TABLE wlans ADD COLUMN missing_from_source_at TEXT;
CREATE INDEX IF NOT EXISTS idx_wlans_source ON wlans (source_integration_id, external_id);
