-- Fractional-width rendering: a U slot can be split into 2 ("half-width")
-- or 3 ("third") equal columns so multiple narrow devices (Mini PC, Regular
-- PC, etc.) can share one U side by side, instead of only the old binary
-- half_width/half_position ("left"/"right" of one shared half) scheme.
-- slot_position is the column index within the slot's slot_width (0/1 for
-- half-width, 0/1/2 for third; always 0 for "full").
ALTER TABLE rack_slots
  ADD COLUMN IF NOT EXISTS slot_width    VARCHAR(20) DEFAULT 'full',
  ADD COLUMN IF NOT EXISTS slot_position TINYINT     DEFAULT 0;

-- Backfill from the old half_width/half_position columns so existing
-- half-width devices keep rendering/colliding correctly under the new,
-- generalized column - half_width/half_position themselves are left in
-- place (unused going forward) rather than dropped.
UPDATE rack_slots
   SET slot_width = 'half-width',
       slot_position = IF(half_position = 'right', 1, 0)
 WHERE half_width = 1;
