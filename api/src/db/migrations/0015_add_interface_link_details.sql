-- Per-interface link metadata (IP address, speed, cable type) that previously
-- lived on topology_edges. These now live on the interface so the same
-- physical port's details are visible in the node's interface list regardless
-- of which edge(s) reference it.
ALTER TABLE topology_node_interfaces ADD COLUMN IF NOT EXISTS ip VARCHAR(45) NULL AFTER description;
ALTER TABLE topology_node_interfaces ADD COLUMN IF NOT EXISTS speed VARCHAR(32) NULL AFTER ip;
ALTER TABLE topology_node_interfaces ADD COLUMN IF NOT EXISTS cable_type VARCHAR(64) NULL AFTER speed;
