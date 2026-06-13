-- VLAN definitions for the per-project VLAN planning module. Each VLAN
-- belongs to a project and can be referenced from topology zones and
-- interface VLAN sub-interfaces.
CREATE TABLE IF NOT EXISTS project_vlans (
    id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id  INT UNSIGNED NOT NULL,
    vlan_id     INT NOT NULL,
    name        VARCHAR(100) NOT NULL,
    description VARCHAR(255) NULL,
    subnet      VARCHAR(50) NULL,
    color       VARCHAR(20) NOT NULL DEFAULT '#4A90E2',
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_project_vlans_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    KEY idx_project_vlans_project (project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
