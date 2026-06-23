-- location_id/room_id are INT UNSIGNED to match locations.id/rooms.id
-- (0053/0054); a signed/unsigned mismatch makes MariaDB reject the FK (errno 150).
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS location_id INT UNSIGNED DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS room_id     INT UNSIGNED DEFAULT NULL;

-- Same guarded-FK pattern as fk_racks_location/fk_racks_room in
-- 0055_racks_location_room.sql. ON DELETE SET NULL so a removed location/room
-- just clears the assignment instead of blocking the delete.
SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'devices'
    AND CONSTRAINT_NAME = 'fk_devices_location'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE devices ADD CONSTRAINT fk_devices_location FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'devices'
    AND CONSTRAINT_NAME = 'fk_devices_room'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE devices ADD CONSTRAINT fk_devices_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE INDEX IF NOT EXISTS idx_devices_location ON devices (location_id);
CREATE INDEX IF NOT EXISTS idx_devices_room ON devices (room_id);
