-- Rooms belong to a Location.  Racks and Devices are assigned to a Room.
-- location_id/id are INT UNSIGNED to match locations.id (0053_create_locations.sql).
CREATE TABLE IF NOT EXISTS rooms (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  location_id INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  floor VARCHAR(100) DEFAULT NULL,
  room_number VARCHAR(100) DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  contact_name VARCHAR(255) DEFAULT NULL,
  contact_phone VARCHAR(100) DEFAULT NULL,
  contact_email VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
