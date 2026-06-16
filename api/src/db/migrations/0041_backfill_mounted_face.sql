-- Backfill mounted_face for slots created before the dual-panel upgrade.
-- Legacy rows have mounted_face=NULL and use front_back/side for face tracking.
-- Maps: side='both' → 'both'; front_back/side 'back' → 'rear'; everything else → 'front'.

UPDATE rack_slots
SET mounted_face = 'both'
WHERE mounted_face IS NULL AND side = 'both';

UPDATE rack_slots
SET mounted_face = 'rear'
WHERE mounted_face IS NULL AND (front_back = 'back' OR side = 'back');

UPDATE rack_slots
SET mounted_face = 'front'
WHERE mounted_face IS NULL;

-- Remove duplicate slots within the same rack/face (keep highest id per group).
-- Duplicates are rows sharing rack_id + project_id + u_position + mounted_face
-- with overlapping U ranges. This handles exact-position duplicates.
DELETE rs1 FROM rack_slots rs1
INNER JOIN rack_slots rs2
  ON  rs1.rack_id    = rs2.rack_id
  AND rs1.project_id = rs2.project_id
  AND rs1.u_position = rs2.u_position
  AND (rs1.mounted_face = rs2.mounted_face
       OR rs1.mounted_face = 'both'
       OR rs2.mounted_face = 'both')
WHERE rs1.id < rs2.id;
