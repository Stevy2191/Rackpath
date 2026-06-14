-- Up/down/testing status for a topology node interface, populated by SNMP
-- scans (ifOperStatus) and kept alongside the existing speed/ip/cable_type
-- link metadata.
ALTER TABLE topology_node_interfaces ADD COLUMN IF NOT EXISTS status VARCHAR(10) NULL AFTER cable_type;
