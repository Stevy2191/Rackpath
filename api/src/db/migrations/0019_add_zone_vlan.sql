-- Let a topology zone be tagged with a project VLAN. When set, the zone is
-- rendered using the VLAN's color and shows the VLAN name/ID as a label.
ALTER TABLE topology_zones ADD COLUMN IF NOT EXISTS vlan_id INT UNSIGNED NULL AFTER color;
ALTER TABLE topology_zones
    ADD CONSTRAINT fk_topology_zones_vlan FOREIGN KEY IF NOT EXISTS (vlan_id)
    REFERENCES project_vlans(id) ON DELETE SET NULL;
