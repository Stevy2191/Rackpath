-- Allow edges to connect any canvas element type (node/shape/zone/label),
-- not just topology_nodes. source_node_id/target_node_id hold the element
-- row id; source/target_element_type tell us which table to look in.
ALTER TABLE topology_edges
  ADD COLUMN IF NOT EXISTS source_element_type VARCHAR(20) NOT NULL DEFAULT 'node',
  ADD COLUMN IF NOT EXISTS target_element_type VARCHAR(20) NOT NULL DEFAULT 'node';

-- Edge path shape: 'bezier' (default smooth curve) or 'straight' (direct line).
ALTER TABLE topology_edges
  ADD COLUMN IF NOT EXISTS path_style VARCHAR(20) NOT NULL DEFAULT 'bezier';
