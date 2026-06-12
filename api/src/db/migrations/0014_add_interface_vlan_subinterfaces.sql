-- VLAN sub-interfaces: an interface row with a parent_id is a VLAN
-- sub-interface of that parent (parent_id NULL means a top-level interface).
-- vlan_id holds the VLAN number for sub-interfaces.
ALTER TABLE topology_node_interfaces ADD COLUMN IF NOT EXISTS parent_id INT UNSIGNED NULL AFTER device_id;
ALTER TABLE topology_node_interfaces ADD COLUMN IF NOT EXISTS vlan_id INT NULL AFTER name;

ALTER TABLE topology_node_interfaces ADD INDEX IF NOT EXISTS idx_topology_node_interfaces_parent (parent_id);

-- Self-referential FK so deleting a parent interface removes its VLAN
-- sub-interfaces. (The DELETE route also removes children explicitly, so this
-- behaves correctly even on a database where the constraint isn't present.)
ALTER TABLE topology_node_interfaces
    ADD CONSTRAINT fk_topology_node_interfaces_parent
    FOREIGN KEY IF NOT EXISTS (parent_id) REFERENCES topology_node_interfaces(id) ON DELETE CASCADE;
