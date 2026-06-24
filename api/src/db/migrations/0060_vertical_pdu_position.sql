-- Vertical PDU side rail channels: a channel (left or right) holds up to 2
-- PDUs, stacked top/bottom. "is a vertical PDU" is already modeled by
-- rack_slots.item_type = 'vertical-pdu', and "which side" already exists as
-- mount_side (ENUM('left','right'), added in 0046_rack_power_management.sql)
-- - only the stacking slot within a side was never stored (it used to be
-- computed live, purely from creation order). This adds that missing column.
ALTER TABLE rack_slots
  ADD COLUMN IF NOT EXISTS vertical_pdu_position TINYINT UNSIGNED DEFAULT NULL AFTER mount_side;

-- Backfill: every existing vertical PDU lands at the top slot (0). The old
-- per-rack cap was 2 PDUs total, alternated left/right by creation order,
-- so no rack could already have 2 PDUs sharing one side - every existing
-- row really is the only occupant of its channel.
UPDATE rack_slots
   SET vertical_pdu_position = 0
 WHERE item_type = 'vertical-pdu' AND mount_side IS NOT NULL;
