-- Rackpath v2, phase 3: ports, connections (cables), VLANs and WLANs.
-- See docs/design/v2-data-model.md section 6 and 9.
--
-- Catalog values (connector, transceiver, cable type) are checked by the
-- API against lists in code (src/domain/media.rs), so new ones don't need
-- a table rebuild. Enumerations that are part of the model are CHECKed here.

CREATE TABLE IF NOT EXISTS vlans (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    vid         INTEGER NOT NULL CHECK (vid BETWEEN 1 AND 4094),
    name        TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    description TEXT,
    color       TEXT    CHECK (color IS NULL OR (length(color) = 7 AND color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
    notes       TEXT,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vlans_vid ON vlans (project_id, vid);

-- No passphrase is stored, by design.
CREATE TABLE IF NOT EXISTS wlans (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    ssid        TEXT    NOT NULL CHECK (length(ssid) BETWEEN 1 AND 32),
    description TEXT,
    security    TEXT    NOT NULL DEFAULT 'wpa2'
                CHECK (security IN ('open', 'owe', 'wpa2', 'wpa3', 'wpa2_wpa3', 'enterprise')),
    hidden      INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    vlan_id     INTEGER REFERENCES vlans (id) ON DELETE SET NULL,
    notes       TEXT,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wlans_project ON wlans (project_id);

CREATE TABLE IF NOT EXISTS ports (
    id                 INTEGER PRIMARY KEY,
    device_id          INTEGER NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    code               TEXT    NOT NULL
                       CHECK (length(code) BETWEEN 1 AND 10 AND code NOT GLOB '*[^A-Z0-9._-]*'),
    face               TEXT    NOT NULL DEFAULT 'front' CHECK (face IN ('front', 'rear')),
    role               TEXT    NOT NULL CHECK (role IN ('active', 'passive')),
    -- Passive ports: the front can only be patched once the rear is cabled
    -- (0 for couplers and pass-through panels).
    requires_permanent INTEGER NOT NULL DEFAULT 1 CHECK (requires_permanent IN (0, 1)),
    medium             TEXT    NOT NULL
                       CHECK (medium IN ('copper', 'fiber', 'wireless', 'power', 'console', 'coax', 'other')),
    connector          TEXT,
    transceiver        TEXT,
    fiber_mode         TEXT    CHECK (fiber_mode IS NULL OR fiber_mode IN ('simplex', 'duplex')),
    sort_order         INTEGER NOT NULL DEFAULT 0,
    -- The name the device itself uses, e.g. "Gi1/0/24" (codes can't hold '/').
    interface_name     TEXT,
    speed              INTEGER CHECK (speed IS NULL OR speed BETWEEN 1 AND 1600000), -- Mb/s
    poe                TEXT    CHECK (poe IS NULL OR poe IN ('af', 'at', 'bt', 'passive')),
    description        TEXT,
    mac                TEXT,
    wlan_id            INTEGER REFERENCES wlans (id) ON DELETE SET NULL,
    notes              TEXT,
    created_at         TEXT    NOT NULL,
    updated_at         TEXT    NOT NULL,
    CHECK (wlan_id IS NULL OR medium = 'wireless'),
    CHECK (transceiver IS NULL OR connector IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ports_code ON ports (device_id, code);
CREATE INDEX IF NOT EXISTS idx_ports_wlan ON ports (wlan_id);

-- One row per physical cable.
CREATE TABLE IF NOT EXISTS connections (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    kind        TEXT    NOT NULL CHECK (kind IN ('permanent', 'patch', 'power')),
    cable_type  TEXT,
    length_m    REAL    CHECK (length_m IS NULL OR (length_m > 0 AND length_m <= 100000)),
    color       TEXT    CHECK (color IS NULL OR (length(color) = 7 AND color GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
    label       TEXT,
    notes       TEXT,
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_connections_project ON connections (project_id);

-- The two ends of a cable. One cable per port side, enforced here.
CREATE TABLE IF NOT EXISTS connection_ends (
    connection_id INTEGER NOT NULL REFERENCES connections (id) ON DELETE CASCADE,
    endpoint      TEXT    NOT NULL CHECK (endpoint IN ('a', 'b')),
    port_id       INTEGER NOT NULL REFERENCES ports (id) ON DELETE CASCADE,
    side          TEXT    NOT NULL CHECK (side IN ('front', 'rear')),
    PRIMARY KEY (connection_id, endpoint)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_connection_ends_port ON connection_ends (port_id, side);

-- A cable that loses an end (its port or device was deleted) goes too.
CREATE TRIGGER IF NOT EXISTS connection_ends_drop_cable AFTER DELETE ON connection_ends BEGIN
    DELETE FROM connections WHERE id = OLD.connection_id;
END;

CREATE TABLE IF NOT EXISTS port_vlans (
    port_id  INTEGER NOT NULL REFERENCES ports (id) ON DELETE CASCADE,
    vlan_id  INTEGER NOT NULL REFERENCES vlans (id) ON DELETE CASCADE,
    mode     TEXT    NOT NULL CHECK (mode IN ('untagged', 'tagged')),
    PRIMARY KEY (port_id, vlan_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_port_vlans_untagged ON port_vlans (port_id) WHERE mode = 'untagged';
CREATE INDEX IF NOT EXISTS idx_port_vlans_vlan ON port_vlans (vlan_id);

-- Paths and search now include ports (kind 'port', device_id = the device
-- the port belongs to). The device path expression is repeated in the port
-- branch on purpose: a shared CTE would be evaluated for every device on
-- each single-item reindex.
DROP VIEW IF EXISTS v_entities;
CREATE VIEW v_entities AS
SELECT 'location' AS kind, l.id AS ref_id, l.project_id,
       l.id AS location_id, NULL AS floor_id, NULL AS room_id, NULL AS rack_id, NULL AS device_id,
       p.code || '/' || l.code AS path,
       concat_ws(' ', l.code, l.name, l.address_street, l.address_city, l.address_postcode, l.contact_name) AS text
FROM locations l JOIN projects p ON p.id = l.project_id
UNION ALL
SELECT 'floor', f.id, l.project_id, l.id, f.id, NULL, NULL, NULL,
       p.code || '/' || l.code || '/' || f.code,
       concat_ws(' ', f.code, f.name)
FROM floors f JOIN locations l ON l.id = f.location_id JOIN projects p ON p.id = l.project_id
UNION ALL
SELECT 'room', r.id, l.project_id, l.id, f.id, r.id, NULL, NULL,
       p.code || '/' || l.code || '/' || f.code || '/' || r.code,
       concat_ws(' ', r.code, r.name, r.contact_name)
FROM rooms r JOIN floors f ON f.id = r.floor_id JOIN locations l ON l.id = f.location_id
     JOIN projects p ON p.id = l.project_id
UNION ALL
SELECT 'rack', k.id, l.project_id, l.id, f.id, r.id, k.id, NULL,
       p.code || '/' || l.code || '/' || f.code || '/' || r.code || '/' || k.code,
       concat_ws(' ', k.code, k.name)
FROM racks k JOIN rooms r ON r.id = k.room_id JOIN floors f ON f.id = r.floor_id
     JOIN locations l ON l.id = f.location_id JOIN projects p ON p.id = l.project_id
UNION ALL
SELECT 'device', d.id, d.project_id, l.id, f.id, r.id, k.id, d.id,
       p.code
         || CASE WHEN r.id IS NULL THEN '/UNPLACED'
                 ELSE '/' || l.code || '/' || f.code || '/' || r.code
                      || COALESCE('/' || k.code, '') || COALESCE('/' || t.code, '') END
         || '/' || d.code,
       concat_ws(' ', d.code, d.name, d.hostname, d.mac, d.serial_number, d.asset_tag,
                 d.manufacturer, d.model, dt.label)
FROM devices d
JOIN projects p ON p.id = d.project_id
JOIN device_types dt ON dt.id = d.device_type_id
LEFT JOIN devices t ON t.id = d.parent_device_id
LEFT JOIN racks k ON k.id = COALESCE(d.rack_id, t.rack_id)
LEFT JOIN rooms r ON r.id = COALESCE(d.room_id, k.room_id)
LEFT JOIN floors f ON f.id = r.floor_id
LEFT JOIN locations l ON l.id = f.location_id
UNION ALL
SELECT 'port', o.id, d.project_id, l.id, f.id, r.id, k.id, d.id,
       p.code
         || CASE WHEN r.id IS NULL THEN '/UNPLACED'
                 ELSE '/' || l.code || '/' || f.code || '/' || r.code
                      || COALESCE('/' || k.code, '') || COALESCE('/' || t.code, '') END
         || '/' || d.code || '/' || o.code,
       concat_ws(' ', o.code, o.interface_name, o.description, o.mac, o.connector, o.transceiver)
FROM ports o
JOIN devices d ON d.id = o.device_id
JOIN projects p ON p.id = d.project_id
LEFT JOIN devices t ON t.id = d.parent_device_id
LEFT JOIN racks k ON k.id = COALESCE(d.rack_id, t.rack_id)
LEFT JOIN rooms r ON r.id = COALESCE(d.room_id, k.room_id)
LEFT JOIN floors f ON f.id = r.floor_id
LEFT JOIN locations l ON l.id = f.location_id;
