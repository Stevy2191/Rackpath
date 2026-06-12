-- project_id -> projects(id) foreign keys for every project-scoped table.
--
-- MariaDB places the IF NOT EXISTS clause after FOREIGN KEY (not after
-- CONSTRAINT); the previous form (ADD CONSTRAINT IF NOT EXISTS ... FOREIGN KEY)
-- is a syntax error. IF NOT EXISTS keeps this idempotent so it is a no-op on
-- deployments where db/init.sql already created these constraints.
ALTER TABLE devices
    ADD CONSTRAINT fk_devices_project FOREIGN KEY IF NOT EXISTS (project_id)
    REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE ports
    ADD CONSTRAINT fk_ports_project FOREIGN KEY IF NOT EXISTS (project_id)
    REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE racks
    ADD CONSTRAINT fk_racks_project FOREIGN KEY IF NOT EXISTS (project_id)
    REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE rack_slots
    ADD CONSTRAINT fk_rack_slots_project FOREIGN KEY IF NOT EXISTS (project_id)
    REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE topology_layout
    ADD CONSTRAINT fk_topology_layout_project FOREIGN KEY IF NOT EXISTS (project_id)
    REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE topology_edges
    ADD CONSTRAINT fk_topology_edges_project FOREIGN KEY IF NOT EXISTS (project_id)
    REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE topology_zones
    ADD CONSTRAINT fk_topology_zones_project FOREIGN KEY IF NOT EXISTS (project_id)
    REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE scan_jobs
    ADD CONSTRAINT fk_scan_jobs_project FOREIGN KEY IF NOT EXISTS (project_id)
    REFERENCES projects(id) ON DELETE CASCADE;
