-- Add topology_id to every canvas table so each element belongs to a specific topology.
ALTER TABLE topology_nodes  ADD COLUMN IF NOT EXISTS topology_id INT UNSIGNED DEFAULT NULL;
ALTER TABLE topology_edges  ADD COLUMN IF NOT EXISTS topology_id INT UNSIGNED DEFAULT NULL;
ALTER TABLE topology_zones  ADD COLUMN IF NOT EXISTS topology_id INT UNSIGNED DEFAULT NULL;
ALTER TABLE topology_labels ADD COLUMN IF NOT EXISTS topology_id INT UNSIGNED DEFAULT NULL;
ALTER TABLE topology_shapes ADD COLUMN IF NOT EXISTS topology_id INT UNSIGNED DEFAULT NULL;

ALTER TABLE topology_nodes  ADD INDEX IF NOT EXISTS idx_topology_nodes_topology  (topology_id);
ALTER TABLE topology_edges  ADD INDEX IF NOT EXISTS idx_topology_edges_topology  (topology_id);
ALTER TABLE topology_zones  ADD INDEX IF NOT EXISTS idx_topology_zones_topology  (topology_id);
ALTER TABLE topology_labels ADD INDEX IF NOT EXISTS idx_topology_labels_topology (topology_id);
ALTER TABLE topology_shapes ADD INDEX IF NOT EXISTS idx_topology_shapes_topology (topology_id);

-- Create a "Main Topology" record for every project that already has canvas data,
-- so existing nodes/edges/zones/labels/shapes can be assigned a topology_id.
INSERT INTO topologies (project_id, name, is_master)
SELECT DISTINCT project_id, 'Main Topology', TRUE
FROM (
  SELECT project_id FROM topology_nodes  WHERE project_id IS NOT NULL
  UNION
  SELECT project_id FROM topology_edges  WHERE project_id IS NOT NULL
  UNION
  SELECT project_id FROM topology_zones  WHERE project_id IS NOT NULL
  UNION
  SELECT project_id FROM topology_labels WHERE project_id IS NOT NULL
  UNION
  SELECT project_id FROM topology_shapes WHERE project_id IS NOT NULL
) AS existing_projects
WHERE project_id NOT IN (SELECT project_id FROM topologies);

-- Backfill topology_id on all existing rows to the master topology for their project.
UPDATE topology_nodes n
  JOIN topologies t ON t.project_id = n.project_id AND t.is_master = TRUE
  SET n.topology_id = t.id
  WHERE n.topology_id IS NULL;

UPDATE topology_edges e
  JOIN topologies t ON t.project_id = e.project_id AND t.is_master = TRUE
  SET e.topology_id = t.id
  WHERE e.topology_id IS NULL;

UPDATE topology_zones z
  JOIN topologies t ON t.project_id = z.project_id AND t.is_master = TRUE
  SET z.topology_id = t.id
  WHERE z.topology_id IS NULL;

UPDATE topology_labels l
  JOIN topologies t ON t.project_id = l.project_id AND t.is_master = TRUE
  SET l.topology_id = t.id
  WHERE l.topology_id IS NULL;

UPDATE topology_shapes s
  JOIN topologies t ON t.project_id = s.project_id AND t.is_master = TRUE
  SET s.topology_id = t.id
  WHERE s.topology_id IS NULL;
