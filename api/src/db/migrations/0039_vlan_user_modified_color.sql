-- Track whether a VLAN's color was explicitly set by the user so auto-assign
-- never overwrites a manual pick during syncs or re-runs.
ALTER TABLE project_vlans
  ADD COLUMN IF NOT EXISTS user_modified_color TINYINT(1) NOT NULL DEFAULT 0 AFTER color;

-- Backfill: assign distinct palette colors to existing VLANs that still have
-- the default blue (#4A90E2).  Uses vlan_id % 16 so VLANs within the same
-- project naturally cycle through distinct palette slots.
UPDATE project_vlans
SET color = ELT(vlan_id % 16 + 1,
    '#4A90E2','#E2704A','#4AE270','#E24A6B','#9B4AE2','#E2C84A',
    '#4AE2D8','#E24AB5','#7BE24A','#4A6BE2','#E2944A','#4AE2A8',
    '#E24A4A','#4AB5E2','#C8E24A','#E27B4A')
WHERE color = '#4A90E2'
  AND user_modified_color = 0;
