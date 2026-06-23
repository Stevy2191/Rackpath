-- Location hierarchy: a Location groups one or more Rooms, each Room holds Racks and Devices.
CREATE TABLE IF NOT EXISTS locations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  building_number VARCHAR(100) DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
