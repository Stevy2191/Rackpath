-- Power management: device power specs, PDU/UPS outlet specs, and power
-- connection mapping (which outlet on which PDU/UPS a device draws from).

-- rack_custom_devices: catalog-level power defaults for user-defined devices.
-- power_draw_w applies to any device; outlet_count/outlet_type/power_capacity/
-- power_capacity_unit/input_voltage only matter when type is 'ups' or 'pdu'.
ALTER TABLE rack_custom_devices
  ADD COLUMN IF NOT EXISTS power_draw_w        DECIMAL(8,2)       NULL AFTER image_url,
  ADD COLUMN IF NOT EXISTS outlet_count        SMALLINT UNSIGNED  NULL AFTER power_draw_w,
  ADD COLUMN IF NOT EXISTS outlet_type         VARCHAR(50)        NULL AFTER outlet_count,
  ADD COLUMN IF NOT EXISTS power_capacity       DECIMAL(8,2)       NULL AFTER outlet_type,
  ADD COLUMN IF NOT EXISTS power_capacity_unit  ENUM('W','VA')     NULL DEFAULT 'W' AFTER power_capacity,
  ADD COLUMN IF NOT EXISTS input_voltage        VARCHAR(20)        NULL AFTER power_capacity_unit;

-- rack_slots: per-instance power spec (copied from catalog/custom-device
-- defaults at creation time, editable afterwards as an override), plus the
-- power connection mapping itself.
ALTER TABLE rack_slots
  ADD COLUMN IF NOT EXISTS power_draw_w        DECIMAL(8,2)       NULL AFTER slot_notes,
  ADD COLUMN IF NOT EXISTS outlet_count        SMALLINT UNSIGNED  NULL AFTER power_draw_w,
  ADD COLUMN IF NOT EXISTS outlet_type         VARCHAR(50)        NULL AFTER outlet_count,
  ADD COLUMN IF NOT EXISTS power_capacity       DECIMAL(8,2)       NULL AFTER outlet_type,
  ADD COLUMN IF NOT EXISTS power_capacity_unit  ENUM('W','VA')     NULL DEFAULT 'W' AFTER power_capacity,
  ADD COLUMN IF NOT EXISTS input_voltage        VARCHAR(20)        NULL AFTER power_capacity_unit,
  ADD COLUMN IF NOT EXISTS power_source_slot_id INT UNSIGNED       NULL AFTER input_voltage,
  ADD COLUMN IF NOT EXISTS power_source_outlet  SMALLINT UNSIGNED  NULL AFTER power_source_slot_id,
  ADD COLUMN IF NOT EXISTS mount_side           ENUM('left','right') NULL AFTER power_source_outlet;

-- Self-referencing FK: when a PDU/UPS slot is deleted, anything plugged into
-- it falls back to "Wall (Direct)" instead of pointing at a dead row.
SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'rack_slots'
    AND CONSTRAINT_NAME = 'fk_rack_slots_power_source'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE rack_slots ADD CONSTRAINT fk_rack_slots_power_source FOREIGN KEY (power_source_slot_id) REFERENCES rack_slots(id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE INDEX IF NOT EXISTS idx_rack_slots_power_source ON rack_slots (power_source_slot_id);
