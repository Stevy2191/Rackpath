-- project_id -> projects(id) foreign keys for every project-scoped table.
ALTER TABLE devices ADD CONSTRAINT IF NOT EXISTS fk_devices_project
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE ports ADD CONSTRAINT IF NOT EXISTS fk_ports_project
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE racks ADD CONSTRAINT IF NOT EXISTS fk_racks_project
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE rack_slots ADD CONSTRAINT IF NOT EXISTS fk_rack_slots_project
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE topology_layout ADD CONSTRAINT IF NOT EXISTS fk_topology_layout_project
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE topology_edges ADD CONSTRAINT IF NOT EXISTS fk_topology_edges_project
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE topology_zones ADD CONSTRAINT IF NOT EXISTS fk_topology_zones_project
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE scan_jobs ADD CONSTRAINT IF NOT EXISTS fk_scan_jobs_project
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
