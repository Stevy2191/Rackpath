-- Timestamp of the most recent per-device SNMP scan.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_scanned_at TIMESTAMP NULL DEFAULT NULL AFTER credential_macro_id;
