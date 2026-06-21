-- Dual PSU support: a device's power cord mapping (power_source_slot_id /
-- power_source_outlet) becomes "PSU 1" — this adds an independent, optional
-- "PSU 2" pair so a device can model two redundant power connections, each
-- to a PDU/UPS in any rack in the project.
ALTER TABLE rack_slots
  ADD COLUMN IF NOT EXISTS psu2_source_slot_id INT UNSIGNED      NULL AFTER power_source_outlet,
  ADD COLUMN IF NOT EXISTS psu2_source_outlet  SMALLINT UNSIGNED NULL AFTER psu2_source_slot_id;

-- Same self-referencing FK pattern as power_source_slot_id: if the PSU2
-- source slot is deleted, PSU2 falls back to "Not connected" instead of
-- pointing at a dead row.
SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'rack_slots'
    AND CONSTRAINT_NAME = 'fk_rack_slots_psu2_source'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE rack_slots ADD CONSTRAINT fk_rack_slots_psu2_source FOREIGN KEY (psu2_source_slot_id) REFERENCES rack_slots(id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE INDEX IF NOT EXISTS idx_rack_slots_psu2_source ON rack_slots (psu2_source_slot_id);
