-- SNMP credentials live only in credential macros now. The per-device
-- community string was stored in plain text and never used for polling.
ALTER TABLE devices DROP COLUMN IF EXISTS snmp_community;

-- Scan results no longer echo the community string that answered.
UPDATE scan_results
SET raw = JSON_REMOVE(raw, '$.snmp_community')
WHERE raw IS NOT NULL AND JSON_VALID(raw) AND JSON_EXISTS(raw, '$.snmp_community');
