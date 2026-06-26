-- UPS runtime curve: replaces the two static 100%/50% runtime fields with a
-- multi-point load/runtime curve for accurate interpolation at any load level.

ALTER TABLE rack_slots
  ADD COLUMN IF NOT EXISTS runtime_curve JSON DEFAULT NULL AFTER ups_runtime_half;

ALTER TABLE rack_slots
  ADD COLUMN IF NOT EXISTS ebm_runtime_curve JSON DEFAULT NULL AFTER ebm_runtime_half;

ALTER TABLE user_catalog_entries
  ADD COLUMN IF NOT EXISTS runtime_curve JSON DEFAULT NULL;

ALTER TABLE user_catalog_entries
  ADD COLUMN IF NOT EXISTS ebm_runtime_curve JSON DEFAULT NULL;

-- Migrate existing UPS two-point data into a minimal two-point curve so
-- existing runtimes are preserved after the upgrade.
UPDATE rack_slots
SET runtime_curve = JSON_ARRAY(
  JSON_OBJECT('load_watts', ROUND(COALESCE(ups_watt_rating, 1000) * 0.5), 'runtime_minutes', ups_runtime_half),
  JSON_OBJECT('load_watts', COALESCE(ups_watt_rating, 1000),              'runtime_minutes', ups_runtime_full)
)
WHERE device_type = 'ups'
  AND runtime_curve IS NULL
  AND ups_runtime_full IS NOT NULL
  AND ups_runtime_half IS NOT NULL;

-- Migrate existing EBM two-point data (join to get the connected UPS watt rating).
UPDATE rack_slots r
JOIN rack_slots u ON u.id = r.ebm_connected_ups_id
SET r.ebm_runtime_curve = JSON_ARRAY(
  JSON_OBJECT('load_watts', ROUND(COALESCE(u.ups_watt_rating, 1000) * 0.5), 'added_runtime_minutes', r.ebm_runtime_half),
  JSON_OBJECT('load_watts', COALESCE(u.ups_watt_rating, 1000),               'added_runtime_minutes', r.ebm_runtime_full)
)
WHERE r.device_type = 'ebm'
  AND r.ebm_runtime_curve IS NULL
  AND r.ebm_runtime_full IS NOT NULL
  AND r.ebm_runtime_half IS NOT NULL;
