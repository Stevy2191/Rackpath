ALTER TABLE racks
  ADD COLUMN IF NOT EXISTS annotation_field  VARCHAR(20)      NULL    AFTER show_rear,
  ADD COLUMN IF NOT EXISTS show_annotations  TINYINT NOT NULL DEFAULT 0 AFTER annotation_field;
