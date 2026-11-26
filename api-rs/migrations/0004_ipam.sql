-- Rackpath v2, phase 4: IP address management. See
-- docs/design/v2-data-model.md section 9.
--
-- Addresses and range bounds are stored twice: canonical text for display
-- and a 16-byte big-endian BLOB (IPv4 in IPv4-mapped form) for sorting
-- and range queries. The API derives the binary form; it is never typed in.
-- Which prefix an address or child prefix belongs to is computed (smallest
-- containing prefix in the same space), not stored.
--
-- Ownership fields: `source` and `external_id` now; the link to the
-- integration that owns a record arrives with integrations in phase 6.

CREATE TABLE IF NOT EXISTS address_spaces (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name        TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    description TEXT,
    is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_address_spaces_name ON address_spaces (project_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_address_spaces_default ON address_spaces (project_id) WHERE is_default = 1;

-- Every existing project gets its Default space.
INSERT INTO address_spaces (project_id, name, is_default, created_at, updated_at)
SELECT p.id, 'Default', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM projects p
WHERE NOT EXISTS (SELECT 1 FROM address_spaces s WHERE s.project_id = p.id AND s.is_default = 1);

CREATE TABLE IF NOT EXISTS prefixes (
    id                     INTEGER PRIMARY KEY,
    project_id             INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    space_id               INTEGER NOT NULL REFERENCES address_spaces (id) ON DELETE CASCADE,
    cidr                   TEXT    NOT NULL,
    family                 INTEGER NOT NULL CHECK (family IN (4, 6)),
    prefix_len             INTEGER NOT NULL CHECK (prefix_len BETWEEN 0 AND 128),
    net_start              BLOB    NOT NULL CHECK (length(net_start) = 16),
    net_end                BLOB    NOT NULL CHECK (length(net_end) = 16),
    vlan_id                INTEGER REFERENCES vlans (id) ON DELETE SET NULL,
    location_id            INTEGER REFERENCES locations (id) ON DELETE SET NULL,
    role                   TEXT    NOT NULL DEFAULT 'other'
                           CHECK (role IN ('users', 'servers', 'management', 'voice', 'printers', 'iot',
                                           'guest', 'transit', 'wan', 'loopback', 'other')),
    status                 TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('planned', 'active', 'deprecated')),
    gateway                TEXT,
    dns_servers            TEXT,
    domain_name            TEXT,
    description            TEXT,
    notes                  TEXT,
    source                 TEXT    NOT NULL DEFAULT 'manual'
                           CHECK (source IN ('manual', 'integration', 'csv_import', 'v1_import')),
    external_id            TEXT,
    missing_from_source_at TEXT,
    created_at             TEXT    NOT NULL,
    updated_at             TEXT    NOT NULL,
    CHECK (net_start <= net_end)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_prefixes_cidr ON prefixes (space_id, cidr);
CREATE INDEX IF NOT EXISTS idx_prefixes_range ON prefixes (space_id, family, net_start, net_end);
CREATE INDEX IF NOT EXISTS idx_prefixes_project ON prefixes (project_id);
CREATE INDEX IF NOT EXISTS idx_prefixes_vlan ON prefixes (vlan_id);
CREATE INDEX IF NOT EXISTS idx_prefixes_location ON prefixes (location_id);

CREATE TABLE IF NOT EXISTS ip_ranges (
    id                     INTEGER PRIMARY KEY,
    prefix_id              INTEGER NOT NULL REFERENCES prefixes (id) ON DELETE CASCADE,
    start_text             TEXT    NOT NULL,
    end_text               TEXT    NOT NULL,
    start_bin              BLOB    NOT NULL CHECK (length(start_bin) = 16),
    end_bin                BLOB    NOT NULL CHECK (length(end_bin) = 16),
    kind                   TEXT    NOT NULL CHECK (kind IN ('dhcp_pool', 'reserved', 'static')),
    description            TEXT,
    source                 TEXT    NOT NULL DEFAULT 'manual'
                           CHECK (source IN ('manual', 'integration', 'csv_import', 'v1_import')),
    external_id            TEXT,
    missing_from_source_at TEXT,
    created_at             TEXT    NOT NULL,
    updated_at             TEXT    NOT NULL,
    CHECK (start_bin <= end_bin)
);
CREATE INDEX IF NOT EXISTS idx_ip_ranges_prefix ON ip_ranges (prefix_id, start_bin);

CREATE TABLE IF NOT EXISTS ip_addresses (
    id                     INTEGER PRIMARY KEY,
    project_id             INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    space_id               INTEGER NOT NULL REFERENCES address_spaces (id) ON DELETE CASCADE,
    address                TEXT    NOT NULL,
    family                 INTEGER NOT NULL CHECK (family IN (4, 6)),
    addr_bin               BLOB    NOT NULL CHECK (length(addr_bin) = 16),
    prefix_len             INTEGER CHECK (prefix_len IS NULL OR prefix_len BETWEEN 0 AND 128),
    -- A port implies its device; the API keeps device_id set for both.
    device_id              INTEGER REFERENCES devices (id) ON DELETE SET NULL,
    port_id                INTEGER REFERENCES ports (id) ON DELETE SET NULL,
    role                   TEXT    NOT NULL DEFAULT 'primary'
                           CHECK (role IN ('primary', 'secondary', 'gateway', 'vip', 'loopback')),
    status                 TEXT    NOT NULL DEFAULT 'assigned' CHECK (status IN ('reserved', 'assigned', 'deprecated')),
    mac                    TEXT,
    dns_name               TEXT,
    dns_aliases            TEXT    CHECK (dns_aliases IS NULL OR json_valid(dns_aliases)),
    dhcp_reservation       INTEGER NOT NULL DEFAULT 0 CHECK (dhcp_reservation IN (0, 1)),
    description            TEXT,
    notes                  TEXT,
    source                 TEXT    NOT NULL DEFAULT 'manual'
                           CHECK (source IN ('manual', 'integration', 'csv_import', 'v1_import')),
    external_id            TEXT,
    missing_from_source_at TEXT,
    created_at             TEXT    NOT NULL,
        updated_at             TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ip_addresses ON ip_addresses (space_id, addr_bin);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_project ON ip_addresses (project_id);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_device ON ip_addresses (device_id);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_port ON ip_addresses (port_id);
CREATE INDEX IF NOT EXISTS idx_ip_addresses_mac ON ip_addresses (mac);

-- Deleting a port or device keeps the address, unassigned from it (no
-- CHECK ties port_id to device_id: the two SET NULL actions run one at a
-- time). The API sets device_id whenever port_id is set.

