-- Rackpath v2, phase 6: integrations and imports, lease snapshots, tags and
-- topology diagrams. See docs/design/v2-data-model.md sections 9 and 15.
--
-- Rackpath reads from systems that already hold the facts and never
-- contacts devices. Every imported record carries its integration and an
-- external id, so later imports update it instead of duplicating it.

CREATE TABLE IF NOT EXISTS integrations (
    id                    INTEGER PRIMARY KEY,
    project_id            INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    kind                  TEXT    NOT NULL
                          CHECK (kind IN ('windows_dhcp', 'unifi', 'unifi_protect', 'unifi_access', 'zabbix')),
    name                  TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    base_url              TEXT,
    username              TEXT,
    -- API key, API token or password, encrypted with RACKPATH_ENCRYPTION_KEY.
    secret_enc            TEXT,
    auth_kind             TEXT    CHECK (auth_kind IS NULL OR auth_kind IN ('api_key', 'password', 'token')),
    verify_tls            INTEGER NOT NULL DEFAULT 1 CHECK (verify_tls IN (0, 1)),
    -- Where imported prefixes and addresses go (NULL = the project's Default space).
    space_id              INTEGER REFERENCES address_spaces (id) ON DELETE SET NULL,
    options               TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(options)),
    -- Windows push: SHA-256 of the import token (the token itself is shown once).
    token_hash            TEXT,
    token_hint            TEXT,
    auto_sync             INTEGER NOT NULL DEFAULT 0 CHECK (auto_sync IN (0, 1)),
    sync_interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (sync_interval_minutes BETWEEN 5 AND 10080),
    -- Imports changing more than this share of the records they own are held.
    hold_threshold_pct    INTEGER NOT NULL DEFAULT 50 CHECK (hold_threshold_pct BETWEEN 1 AND 100),
    last_sync_at          TEXT,
    last_status           TEXT,
    last_message          TEXT,
    created_at            TEXT    NOT NULL,
    updated_at            TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_name ON integrations (project_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_integrations_token ON integrations (token_hash) WHERE token_hash IS NOT NULL;

-- One row per sync, push or upload. A held import keeps its data in
-- `payload` until an admin approves or rejects it.
CREATE TABLE IF NOT EXISTS sync_runs (
    id             INTEGER PRIMARY KEY,
    integration_id INTEGER NOT NULL REFERENCES integrations (id) ON DELETE CASCADE,
    trigger        TEXT    NOT NULL CHECK (trigger IN ('manual', 'auto', 'push', 'upload', 'approval')),
    status         TEXT    NOT NULL
                   CHECK (status IN ('running', 'success', 'failed', 'held', 'approved', 'rejected', 'superseded')),
    started_at     TEXT    NOT NULL,
    finished_at    TEXT,
    summary        TEXT    CHECK (summary IS NULL OR json_valid(summary)),
    message        TEXT,
    payload        TEXT,
    decided_by     INTEGER REFERENCES users (id) ON DELETE SET NULL,
    decided_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_runs ON sync_runs (integration_id, id);

-- Ownership columns on what imports create.
ALTER TABLE devices ADD COLUMN source_integration_id INTEGER REFERENCES integrations (id) ON DELETE SET NULL;
ALTER TABLE devices ADD COLUMN missing_from_source_at TEXT;
-- e.g. the "Open in Zabbix" link.
ALTER TABLE devices ADD COLUMN external_url TEXT;
ALTER TABLE prefixes ADD COLUMN source_integration_id INTEGER REFERENCES integrations (id) ON DELETE SET NULL;
ALTER TABLE ip_ranges ADD COLUMN source_integration_id INTEGER REFERENCES integrations (id) ON DELETE SET NULL;
ALTER TABLE ip_addresses ADD COLUMN source_integration_id INTEGER REFERENCES integrations (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_source ON devices (source_integration_id, external_id)
    WHERE source_integration_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_prefixes_source ON prefixes (source_integration_id, external_id)
    WHERE source_integration_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_ranges_source ON ip_ranges (source_integration_id, external_id)
    WHERE source_integration_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_addresses_source ON ip_addresses (source_integration_id, external_id)
    WHERE source_integration_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_devices_mac ON devices (project_id, mac);

-- DHCP leases as last seen by an integration. Not documentation: replaced
-- wholesale on every import and never turned into addresses automatically.
CREATE TABLE IF NOT EXISTS dhcp_lease_snapshots (
    id             INTEGER PRIMARY KEY,
    integration_id INTEGER NOT NULL REFERENCES integrations (id) ON DELETE CASCADE,
    space_id       INTEGER NOT NULL REFERENCES address_spaces (id) ON DELETE CASCADE,
    address        TEXT    NOT NULL,
    family         INTEGER NOT NULL CHECK (family IN (4, 6)),
    addr_bin       BLOB    NOT NULL CHECK (length(addr_bin) = 16),
    mac            TEXT,
    hostname       TEXT,
    expires_at     TEXT,
    state          TEXT,
    captured_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leases_addr ON dhcp_lease_snapshots (space_id, family, addr_bin);
CREATE INDEX IF NOT EXISTS idx_leases_integration ON dhcp_lease_snapshots (integration_id);

-- Tags on devices.
CREATE TABLE IF NOT EXISTS tags (
    id         INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name       TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
    color      TEXT    CHECK (color IS NULL OR (length(color) = 7 AND color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
    created_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tags_name ON tags (project_id, name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS device_tags (
    device_id INTEGER NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    PRIMARY KEY (device_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_device_tags_tag ON device_tags (tag_id);

-- Logical topology diagrams. A diagram is saved as a whole; nodes may stand
-- for documented devices, and an edge may be backed by a real cable.
CREATE TABLE IF NOT EXISTS topologies (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name        TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    description TEXT,
    viewport    TEXT    CHECK (viewport IS NULL OR json_valid(viewport)),
    version     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_topologies_name ON topologies (project_id, name);

CREATE TABLE IF NOT EXISTS topology_nodes (
    id          INTEGER PRIMARY KEY,
    topology_id INTEGER NOT NULL REFERENCES topologies (id) ON DELETE CASCADE,
    key         TEXT    NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
    device_id   INTEGER REFERENCES devices (id) ON DELETE SET NULL,
    label       TEXT,
    x           REAL    NOT NULL,
    y           REAL    NOT NULL,
    width       REAL,
    height      REAL,
    style       TEXT    CHECK (style IS NULL OR json_valid(style))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_topology_nodes ON topology_nodes (topology_id, key);
CREATE INDEX IF NOT EXISTS idx_topology_nodes_device ON topology_nodes (device_id);

CREATE TABLE IF NOT EXISTS topology_edges (
    id            INTEGER PRIMARY KEY,
    topology_id   INTEGER NOT NULL REFERENCES topologies (id) ON DELETE CASCADE,
    source_node   INTEGER NOT NULL REFERENCES topology_nodes (id) ON DELETE CASCADE,
    target_node   INTEGER NOT NULL REFERENCES topology_nodes (id) ON DELETE CASCADE,
    connection_id INTEGER REFERENCES connections (id) ON DELETE SET NULL,
    label         TEXT,
    style         TEXT    CHECK (style IS NULL OR json_valid(style))
);
CREATE INDEX IF NOT EXISTS idx_topology_edges ON topology_edges (topology_id);

-- Zones, free labels and shapes drawn on a diagram.
CREATE TABLE IF NOT EXISTS topology_items (
    id          INTEGER PRIMARY KEY,
    topology_id INTEGER NOT NULL REFERENCES topologies (id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL CHECK (kind IN ('zone', 'label', 'shape')),
    x           REAL    NOT NULL,
    y           REAL    NOT NULL,
    width       REAL,
    height      REAL,
    text        TEXT,
    style       TEXT    CHECK (style IS NULL OR json_valid(style))
);
CREATE INDEX IF NOT EXISTS idx_topology_items ON topology_items (topology_id);
