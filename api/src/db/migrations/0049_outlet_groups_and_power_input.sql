-- Outlet group modeling: a single UPS/PDU often has mixed outlet types
-- (e.g. 6x NEMA 5-15R + 2x C19), which the old flat outlet_count +
-- outlet_type pair couldn't represent. outlet_groups holds an array of
-- {type, count} objects instead. Also adds input-side modeling: the plug
-- type on the UPS/PDU's own power cord, and (for PDUs) a capacity value
-- with a selectable unit (Amps or Watts) — UPS capacity stays on the
-- existing capacity_va column, unchanged.

ALTER TABLE rack_slots
  ADD COLUMN IF NOT EXISTS input_plug_type VARCHAR(50) NULL AFTER input_voltage,
  ADD COLUMN IF NOT EXISTS capacity_value SMALLINT UNSIGNED NULL AFTER capacity_va,
  ADD COLUMN IF NOT EXISTS capacity_unit VARCHAR(10) NULL AFTER capacity_value,
  ADD COLUMN IF NOT EXISTS outlet_groups JSON NULL AFTER outlet_type;

ALTER TABLE user_catalog_entries
  ADD COLUMN IF NOT EXISTS input_plug_type VARCHAR(50) NULL AFTER input_voltage,
  ADD COLUMN IF NOT EXISTS capacity_value SMALLINT UNSIGNED NULL AFTER capacity_va,
  ADD COLUMN IF NOT EXISTS capacity_unit VARCHAR(10) NULL AFTER capacity_value,
  ADD COLUMN IF NOT EXISTS outlet_groups JSON NULL AFTER outlet_type;

-- Backfill: fold the old single outlet_count + outlet_type into a
-- single-entry outlet_groups array so existing data isn't lost.
UPDATE rack_slots
  SET outlet_groups = JSON_ARRAY(JSON_OBJECT('type', outlet_type, 'count', outlet_count))
  WHERE outlet_count IS NOT NULL AND outlet_count > 0 AND outlet_groups IS NULL;

UPDATE user_catalog_entries
  SET outlet_groups = JSON_ARRAY(JSON_OBJECT('type', outlet_type, 'count', outlet_count))
  WHERE outlet_count IS NOT NULL AND outlet_count > 0 AND outlet_groups IS NULL;

ALTER TABLE rack_slots
  DROP COLUMN IF EXISTS outlet_count,
  DROP COLUMN IF EXISTS outlet_type;

ALTER TABLE user_catalog_entries
  DROP COLUMN IF EXISTS outlet_count,
  DROP COLUMN IF EXISTS outlet_type;
