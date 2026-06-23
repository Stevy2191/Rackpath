-- location_id/room_id are INT UNSIGNED to match locations.id/rooms.id
-- (0053/0054); a signed/unsigned mismatch makes MariaDB reject the FK (errno 150).
ALTER TABLE racks
  ADD COLUMN IF NOT EXISTS location_id INT UNSIGNED DEFAULT NULL AFTER notes,
  ADD COLUMN IF NOT EXISTS room_id     INT UNSIGNED DEFAULT NULL AFTER location_id;

-- MariaDB has no "ADD CONSTRAINT IF NOT EXISTS" - guard with a lookup against
-- information_schema instead, same pattern as fk_rack_slots_psu2_source in
-- 0050_dual_psu_support.sql. ON DELETE SET NULL so a removed location/room
-- just clears the assignment instead of blocking the delete.
SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'racks'
    AND CONSTRAINT_NAME = 'fk_racks_location'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE racks ADD CONSTRAINT fk_racks_location FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'racks'
    AND CONSTRAINT_NAME = 'fk_racks_room'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE racks ADD CONSTRAINT fk_racks_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE INDEX IF NOT EXISTS idx_racks_location ON racks (location_id);
CREATE INDEX IF NOT EXISTS idx_racks_room ON racks (room_id);
