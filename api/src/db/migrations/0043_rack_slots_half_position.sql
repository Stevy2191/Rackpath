-- Track which horizontal half of the rack column a half-width device occupies.
-- Two half-width devices can share the same U rows on the same face as long as
-- they are on opposite halves (left vs right).
ALTER TABLE rack_slots
  ADD COLUMN IF NOT EXISTS half_position ENUM('left', 'right') NOT NULL DEFAULT 'left'
  AFTER half_width;
