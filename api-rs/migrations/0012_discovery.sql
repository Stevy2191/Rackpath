-- Network discovery: opt-in ping sweeps of a prefix and read-only SNMP
-- polling of routers (ARP tables) and switches (MAC address tables).
--
-- Nothing is scanned unless an admin turns it on for a prefix or adds an
-- SNMP device. What is found goes to a review list (discovered_hosts); it
-- never becomes documentation on its own. Documented addresses only get
-- "last seen" facts.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS; sqlx records which migrations
-- have run, so these ALTERs run exactly once per database.

-- Per-prefix scan settings. scan_interval_minutes NULL = manual scans only.
ALTER TABLE prefixes ADD COLUMN scan_enabled INTEGER NOT NULL DEFAULT 0 CHECK (scan_enabled IN (0, 1));
ALTER TABLE prefixes ADD COLUMN scan_interval_minutes INTEGER
    CHECK (scan_interval_minutes IS NULL OR scan_interval_minutes BETWEEN 60 AND 10080);
ALTER TABLE prefixes ADD COLUMN last_scan_at TEXT;

-- What discovery last saw at a documented address.
ALTER TABLE ip_addresses ADD COLUMN last_seen_at TEXT;
ALTER TABLE ip_addresses ADD COLUMN last_seen_mac TEXT;
ALTER TABLE ip_addresses ADD COLUMN last_seen_port TEXT;

-- Read-only SNMP sources. Community strings and v3 passwords are
-- encrypted with RACKPATH_ENCRYPTION_KEY and never returned by the API.
CREATE TABLE IF NOT EXISTS snmp_sources (
    id                    INTEGER PRIMARY KEY,
    project_id            INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name                  TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    host                  TEXT    NOT NULL,
    port                  INTEGER NOT NULL DEFAULT 161 CHECK (port BETWEEN 1 AND 65535),
    version               TEXT    NOT NULL CHECK (version IN ('2c', '3')),
    community_enc         TEXT,
    v3_username           TEXT,
    v3_auth_protocol      TEXT    CHECK (v3_auth_protocol IS NULL OR v3_auth_protocol IN ('sha1', 'sha256', 'sha384', 'sha512')),
    v3_auth_enc           TEXT,
    v3_priv_protocol      TEXT    CHECK (v3_priv_protocol IS NULL OR v3_priv_protocol IN ('aes128', 'aes192', 'aes256')),
    v3_priv_enc           TEXT,
    -- Where found addresses are matched (NULL = the project's Default space).
    space_id              INTEGER REFERENCES address_spaces (id) ON DELETE SET NULL,
    read_arp              INTEGER NOT NULL DEFAULT 1 CHECK (read_arp IN (0, 1)),
    read_mac_table        INTEGER NOT NULL DEFAULT 1 CHECK (read_mac_table IN (0, 1)),
    enabled               INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    -- NULL = poll by hand only.
    poll_interval_minutes INTEGER CHECK (poll_interval_minutes IS NULL OR poll_interval_minutes BETWEEN 60 AND 10080),
    last_poll_at          TEXT,
    last_status           TEXT,
    last_message          TEXT,
    created_at            TEXT    NOT NULL,
    updated_at            TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_snmp_sources_name ON snmp_sources (project_id, name);

-- One row per ping sweep or SNMP poll.
CREATE TABLE IF NOT EXISTS discovery_runs (
    id             INTEGER PRIMARY KEY,
    project_id     INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    prefix_id      INTEGER REFERENCES prefixes (id) ON DELETE CASCADE,
    snmp_source_id INTEGER REFERENCES snmp_sources (id) ON DELETE CASCADE,
    trigger        TEXT    NOT NULL CHECK (trigger IN ('manual', 'schedule')),
    status         TEXT    NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    started_at     TEXT    NOT NULL,
    finished_at    TEXT,
    probed         INTEGER NOT NULL DEFAULT 0,
    found          INTEGER NOT NULL DEFAULT 0,
    new_hosts      INTEGER NOT NULL DEFAULT 0,
    message        TEXT,
    CHECK ((prefix_id IS NULL) <> (snmp_source_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_prefix ON discovery_runs (prefix_id, id);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_snmp ON discovery_runs (snmp_source_id, id);

-- Live hosts at addresses nobody has documented, waiting for review.
-- Documenting one creates an ip_addresses row and removes it from here.
CREATE TABLE IF NOT EXISTS discovered_hosts (
    id            INTEGER PRIMARY KEY,
    project_id    INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    space_id      INTEGER NOT NULL REFERENCES address_spaces (id) ON DELETE CASCADE,
    address       TEXT    NOT NULL,
    family        INTEGER NOT NULL CHECK (family IN (4, 6)),
    addr_bin      BLOB    NOT NULL CHECK (length(addr_bin) = 16),
    mac           TEXT,
    dns_name      TEXT,
    switch_port   TEXT,
    seen_by_ping  INTEGER NOT NULL DEFAULT 0 CHECK (seen_by_ping IN (0, 1)),
    seen_by_snmp  INTEGER NOT NULL DEFAULT 0 CHECK (seen_by_snmp IN (0, 1)),
    state         TEXT    NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'ignored')),
    first_seen_at TEXT    NOT NULL,
    last_seen_at  TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_discovered_hosts ON discovered_hosts (space_id, addr_bin);
CREATE INDEX IF NOT EXISTS idx_discovered_hosts_project ON discovered_hosts (project_id, state);
