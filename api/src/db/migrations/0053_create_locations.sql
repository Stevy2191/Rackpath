-- Location hierarchy: a Location groups one or more Rooms, each Room holds Racks and Devices.
-- project_id/id are INT UNSIGNED to match projects.id (db/init.sql): MariaDB
-- rejects a FK whose column type doesn't exactly match the referenced column
-- (errno 150), and signed vs unsigned counts as a mismatch.
CREATE TABLE IF NOT EXISTS locations (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  project_id INT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  building_number VARCHAR(100) DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
