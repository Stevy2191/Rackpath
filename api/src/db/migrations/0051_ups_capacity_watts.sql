-- UPS devices previously only stored capacity in VA. This adds a separate
-- watts column so users can record both specifications independently.

ALTER TABLE rack_slots
  ADD COLUMN IF NOT EXISTS capacity_w SMALLINT UNSIGNED NULL AFTER capacity_va;

ALTER TABLE user_catalog_entries
  ADD COLUMN IF NOT EXISTS capacity_w SMALLINT UNSIGNED NULL AFTER capacity_va;
