-- racks: rack width standard and layout type (column vs bayed)
ALTER TABLE racks
  ADD COLUMN IF NOT EXISTS rack_width VARCHAR(20) NOT NULL DEFAULT '19"' AFTER rack_type,
  ADD COLUMN IF NOT EXISTS layout_type VARCHAR(20) NOT NULL DEFAULT 'column' AFTER rack_width;

-- rack_slots: new visual and metadata columns for the overhaul
ALTER TABLE rack_slots
  ADD COLUMN IF NOT EXISTS mounted_face ENUM('front','rear','both') NOT NULL DEFAULT 'front' AFTER front_back,
  ADD COLUMN IF NOT EXISTS half_depth TINYINT(1) NOT NULL DEFAULT 0 AFTER mounted_face,
  ADD COLUMN IF NOT EXISTS half_width TINYINT(1) NOT NULL DEFAULT 0 AFTER half_depth,
  ADD COLUMN IF NOT EXISTS position_offset DECIMAL(4,3) NOT NULL DEFAULT 0.000 AFTER u_position,
  ADD COLUMN IF NOT EXISTS front_image_url VARCHAR(500) NULL AFTER custom_image_url,
  ADD COLUMN IF NOT EXISTS rear_image_url VARCHAR(500) NULL AFTER front_image_url,
  ADD COLUMN IF NOT EXISTS ip_address VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS slot_notes TEXT NULL;

-- Backfill mounted_face from existing front_back/side columns so existing
-- placements render on the correct panel in the new side-by-side layout.
UPDATE rack_slots SET mounted_face = CASE
  WHEN side = 'both' THEN 'both'
  WHEN front_back = 'back' THEN 'rear'
  ELSE 'front'
END
WHERE mounted_face = 'front';
