-- SNMP enrichment for subnet scans: remember which credential macro answered
-- for each discovered host (drives the "SNMP" badge and pre-selects the macro
-- on import), and a per-job flag for whether SNMP enrichment was requested.
ALTER TABLE scan_results ADD COLUMN IF NOT EXISTS snmp_macro_id INT UNSIGNED NULL AFTER raw;
ALTER TABLE scan_results ADD INDEX IF NOT EXISTS idx_scan_results_snmp_macro (snmp_macro_id);
ALTER TABLE scan_results
    ADD CONSTRAINT fk_scan_results_snmp_macro FOREIGN KEY IF NOT EXISTS (snmp_macro_id)
    REFERENCES project_credential_macros(id) ON DELETE SET NULL;

ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS snmp_enrichment BOOLEAN NOT NULL DEFAULT FALSE AFTER scan_profile;
