ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS source_handle VARCHAR(16) NULL AFTER target_device_id;
ALTER TABLE topology_edges ADD COLUMN IF NOT EXISTS target_handle VARCHAR(16) NULL AFTER source_handle;
