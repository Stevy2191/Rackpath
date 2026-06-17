ALTER TABLE rack_slots
  ADD COLUMN IF NOT EXISTS asset_tag     VARCHAR(100) NULL AFTER slot_notes,
  ADD COLUMN IF NOT EXISTS serial_number VARCHAR(100) NULL AFTER asset_tag;
