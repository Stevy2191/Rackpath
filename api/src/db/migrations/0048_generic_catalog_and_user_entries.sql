-- Generic device catalog rework: devices now carry richer per-instance
-- config (port/bay counts, UPS capacity) instead of relying on fixed-size
-- vendor catalog entries, and users can save a placed device's full
-- configuration as a reusable personal catalog entry.

ALTER TABLE rack_slots
  ADD COLUMN IF NOT EXISTS port_count  SMALLINT UNSIGNED NULL AFTER input_voltage,
  ADD COLUMN IF NOT EXISTS bay_count   SMALLINT UNSIGNED NULL AFTER port_count,
  ADD COLUMN IF NOT EXISTS capacity_va SMALLINT UNSIGNED NULL AFTER bay_count;

-- Per-user (not per-project) saved catalog entries, populated via
-- "Save to Catalog" from a placed device's properties panel.
CREATE TABLE IF NOT EXISTS user_catalog_entries (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id       INT UNSIGNED NOT NULL,
    name          VARCHAR(255) NOT NULL,
    render_type   VARCHAR(50)  NOT NULL DEFAULT 'other',
    u_size        INT UNSIGNED NOT NULL DEFAULT 1,
    color         VARCHAR(20)  NULL,
    half_width    TINYINT(1)   NOT NULL DEFAULT 0,
    half_depth    TINYINT(1)   NOT NULL DEFAULT 0,
    mounted_face  ENUM('front','rear','both') NOT NULL DEFAULT 'front',
    outlet_count  SMALLINT UNSIGNED NULL,
    outlet_type   VARCHAR(50)  NULL,
    input_voltage VARCHAR(20)  NULL,
    capacity_va   SMALLINT UNSIGNED NULL,
    port_count    SMALLINT UNSIGNED NULL,
    bay_count     SMALLINT UNSIGNED NULL,
    created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_user_catalog_entries_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    KEY idx_user_catalog_entries_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
