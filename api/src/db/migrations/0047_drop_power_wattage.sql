-- Simplify power management to pure connection mapping: drop wattage/load
-- tracking entirely. Outlet count/type and input voltage stay (still needed
-- for accurate outlet mapping); power_source_slot_id/outlet/mount_side stay
-- (the actual "what's plugged into what" wiring).

ALTER TABLE rack_custom_devices
  DROP COLUMN IF EXISTS power_draw_w,
  DROP COLUMN IF EXISTS power_capacity,
  DROP COLUMN IF EXISTS power_capacity_unit;

ALTER TABLE rack_slots
  DROP COLUMN IF EXISTS power_draw_w,
  DROP COLUMN IF EXISTS power_capacity,
  DROP COLUMN IF EXISTS power_capacity_unit;
