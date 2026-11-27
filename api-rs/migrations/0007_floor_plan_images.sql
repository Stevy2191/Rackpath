-- Rackpath v2, phase 7: floor plan images (decision D6: plans are images).
-- The file lives in <data dir>/uploads/floor-plans/<plan_image>; the
-- database keeps its name and type. plan_width/plan_height are set from the
-- image so devices and rooms keep their coordinates on it.
ALTER TABLE floors ADD COLUMN plan_image TEXT;
ALTER TABLE floors ADD COLUMN plan_image_type TEXT
    CHECK (plan_image_type IS NULL OR plan_image_type IN ('image/png', 'image/jpeg', 'image/webp'));
