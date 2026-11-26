-- Rackpath v2, phase 2: locations, floors, rooms, racks, device types,
-- devices, full paths and search. See docs/design/v2-data-model.md
-- sections 2-5 and 13.

-- Codes: 1-16 characters of A-Z, 0-9, '.', '_', '-'. The API also checks
-- that a code starts with a letter or digit.

CREATE TABLE IF NOT EXISTS locations (
    id                    INTEGER PRIMARY KEY,
    project_id            INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    code                  TEXT    NOT NULL
                          CHECK (length(code) BETWEEN 1 AND 16 AND code NOT GLOB '*[^A-Z0-9._-]*'),
    name                  TEXT    CHECK (name IS NULL OR length(name) <= 255),
    address_street        TEXT,
    address_city          TEXT,
    address_state         TEXT,
    address_postcode      TEXT,
    address_country       TEXT,
    contact_name          TEXT,
    contact_phone         TEXT,
    contact_email         TEXT,
    responsible_user_id   INTEGER REFERENCES users (id) ON DELETE SET NULL,
    isp_primary_name      TEXT,
    isp_primary_circuit   TEXT,
    isp_primary_contact   TEXT,
    isp_secondary_name    TEXT,
    isp_secondary_circuit TEXT,
    isp_secondary_contact TEXT,
    notes                 TEXT,
    created_at            TEXT    NOT NULL,
    updated_at            TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_code ON locations (project_id, code);

CREATE TABLE IF NOT EXISTS floors (
    id              INTEGER PRIMARY KEY,
    location_id     INTEGER NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
    code            TEXT    NOT NULL
                    CHECK (length(code) BETWEEN 1 AND 16 AND code NOT GLOB '*[^A-Z0-9._-]*'),
    name            TEXT    CHECK (name IS NULL OR length(name) <= 255),
    level           INTEGER NOT NULL,
    -- Floor plan geometry (the image itself arrives with attachments).
    plan_width      INTEGER CHECK (plan_width IS NULL OR plan_width > 0),
    plan_height     INTEGER CHECK (plan_height IS NULL OR plan_height > 0),
    scale_px_per_m  REAL    CHECK (scale_px_per_m IS NULL OR scale_px_per_m > 0),
    notes           TEXT,
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_floors_code ON floors (location_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_floors_level ON floors (location_id, level);

CREATE TABLE IF NOT EXISTS rooms (
    id                  INTEGER PRIMARY KEY,
    floor_id            INTEGER NOT NULL REFERENCES floors (id) ON DELETE CASCADE,
    code                TEXT    NOT NULL
                        CHECK (length(code) BETWEEN 1 AND 16 AND code NOT GLOB '*[^A-Z0-9._-]*'),
    name                TEXT    CHECK (name IS NULL OR length(name) <= 255),
    is_default          INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    shape               TEXT    CHECK (shape IS NULL OR json_valid(shape)),
    color               TEXT,
    contact_name        TEXT,
    contact_phone       TEXT,
    contact_email       TEXT,
    responsible_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
    notes               TEXT,
    created_at          TEXT    NOT NULL,
    updated_at          TEXT    NOT NULL,
    -- The code DEFAULT is reserved for each floor's automatic room.
    CHECK ((code = 'DEFAULT') = (is_default = 1)),
    CHECK (is_default = 0 OR shape IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rooms_code ON rooms (floor_id, code);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rooms_one_default ON rooms (floor_id) WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS racks (
    id                  INTEGER PRIMARY KEY,
    room_id             INTEGER NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
    code                TEXT    NOT NULL
                        CHECK (length(code) BETWEEN 1 AND 16 AND code NOT GLOB '*[^A-Z0-9._-]*'),
    name                TEXT    CHECK (name IS NULL OR length(name) <= 255),
    u_height            INTEGER NOT NULL CHECK (u_height BETWEEN 1 AND 60),
    width               TEXT    NOT NULL DEFAULT '19in' CHECK (width IN ('19in', '23in', '10in')),
    depth_mm            INTEGER CHECK (depth_mm IS NULL OR depth_mm BETWEEN 100 AND 2000),
    numbering           TEXT    NOT NULL DEFAULT 'bottom_up' CHECK (numbering IN ('bottom_up', 'top_down')),
    rack_type           TEXT    NOT NULL DEFAULT 'enclosed'
                        CHECK (rack_type IN ('enclosed', 'open_frame', 'wall_mount', 'other')),
    plan_x              REAL,
    plan_y              REAL,
    plan_rotation       REAL,
    responsible_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
    notes               TEXT,
    created_at          TEXT    NOT NULL,
    updated_at          TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_racks_code ON racks (room_id, code);

CREATE TABLE IF NOT EXISTS device_types (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    key         TEXT    NOT NULL CHECK (length(key) BETWEEN 1 AND 40 AND key GLOB '[a-z]*'
                                        AND key NOT GLOB '*[^a-z0-9_]*'),
    label       TEXT    NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
    prefix      TEXT    NOT NULL CHECK (length(prefix) BETWEEN 1 AND 6 AND prefix NOT GLOB '*[^A-Z0-9]*'),
    placement   TEXT    NOT NULL CHECK (placement IN ('floor', 'rack', 'either', 'tray')),
    icon        TEXT,
    is_builtin  INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_types_key ON device_types (project_id, key);
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_types_prefix ON device_types (project_id, prefix);

-- One table for every physical thing. Exactly one placement (or none:
-- unplaced). Rack positions are stored in half-rack-unit steps:
-- rack_pos_half 0 is the bottom of U1, 1 is U1.5, 2 is U2 and so on.
CREATE TABLE IF NOT EXISTS devices (
    id                  INTEGER PRIMARY KEY,
    project_id          INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    device_type_id      INTEGER NOT NULL REFERENCES device_types (id),
    code                TEXT    NOT NULL
                        CHECK (length(code) BETWEEN 1 AND 16 AND code NOT GLOB '*[^A-Z0-9._-]*'),
    name                TEXT    CHECK (name IS NULL OR length(name) <= 255),
    -- placement: floor
    room_id             INTEGER REFERENCES rooms (id) ON DELETE CASCADE,
    plan_x              REAL,
    plan_y              REAL,
    plan_rotation       REAL,
    -- placement: rack
    rack_id             INTEGER REFERENCES racks (id) ON DELETE CASCADE,
    rack_pos_half       INTEGER CHECK (rack_pos_half IS NULL OR rack_pos_half >= 0),
    rack_face           TEXT    CHECK (rack_face IS NULL OR rack_face IN ('front', 'rear', 'both')),
    rack_mount          TEXT    CHECK (rack_mount IS NULL OR rack_mount IN
                                ('full_width', 'half_left', 'half_right', 'zero_u_left', 'zero_u_right')),
    -- placement: on a tray
    parent_device_id    INTEGER REFERENCES devices (id) ON DELETE CASCADE,
    -- geometry
    u_height_half       INTEGER CHECK (u_height_half IS NULL OR u_height_half BETWEEN 1 AND 120),
    depth               TEXT    CHECK (depth IS NULL OR depth IN ('half', 'full')),
    -- inventory
    manufacturer        TEXT,
    model               TEXT,
    serial_number       TEXT,
    asset_tag           TEXT,
    purchase_date       TEXT,
    warranty_expiry     TEXT,
    in_service_date     TEXT,
    responsible_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
    status              TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('planned', 'active', 'spare', 'faulty', 'retired')),
    -- recorded network identity (never polled)
    hostname            TEXT,
    mac                 TEXT,
    os                  TEXT,
    firmware            TEXT,
    -- origin
    source              TEXT    NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('manual', 'integration', 'csv_import', 'v1_import')),
    external_id         TEXT,
    -- display
    icon_color          TEXT,
    text_color          TEXT,
    notes               TEXT,
    created_at          TEXT    NOT NULL,
    updated_at          TEXT    NOT NULL,
    -- Sibling uniqueness: unique indexes treat NULLs as distinct, so the
    -- parent is folded into one never-NULL key.
    parent_key          TEXT GENERATED ALWAYS AS (
                            CASE
                                WHEN parent_device_id IS NOT NULL THEN 'd:' || parent_device_id
                                WHEN rack_id IS NOT NULL THEN 'k:' || rack_id
                                WHEN room_id IS NOT NULL THEN 'r:' || room_id
                                ELSE 'u:' || project_id
                            END) STORED,
    CHECK ((room_id IS NOT NULL) + (rack_id IS NOT NULL) + (parent_device_id IS NOT NULL) <= 1),
    CHECK (rack_id IS NOT NULL OR (rack_pos_half IS NULL AND rack_face IS NULL AND rack_mount IS NULL)),
    CHECK (rack_id IS NULL OR (rack_mount IS NOT NULL AND rack_face IS NOT NULL
                               AND (rack_pos_half IS NOT NULL OR rack_mount IN ('zero_u_left', 'zero_u_right')))),
    CHECK (room_id IS NOT NULL OR (plan_x IS NULL AND plan_y IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_code ON devices (parent_key, code);
CREATE INDEX IF NOT EXISTS idx_devices_project ON devices (project_id);
CREATE INDEX IF NOT EXISTS idx_devices_room ON devices (room_id);
CREATE INDEX IF NOT EXISTS idx_devices_rack ON devices (rack_id);
CREATE INDEX IF NOT EXISTS idx_devices_parent ON devices (parent_device_id);
CREATE INDEX IF NOT EXISTS idx_devices_type ON devices (device_type_id);

-- Grants on a scope that no longer exists are removed with it (these also
-- fire for rows removed by ON DELETE CASCADE).
CREATE TRIGGER IF NOT EXISTS locations_drop_grants AFTER DELETE ON locations BEGIN
    DELETE FROM role_grants WHERE scope_type = 'location' AND scope_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS floors_drop_grants AFTER DELETE ON floors BEGIN
    DELETE FROM role_grants WHERE scope_type = 'floor' AND scope_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS rooms_drop_grants AFTER DELETE ON rooms BEGIN
    DELETE FROM role_grants WHERE scope_type = 'room' AND scope_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS racks_drop_grants AFTER DELETE ON racks BEGIN
    DELETE FROM role_grants WHERE scope_type = 'rack' AND scope_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS devices_drop_grants AFTER DELETE ON devices BEGIN
    DELETE FROM role_grants WHERE scope_type = 'device' AND scope_id = OLD.id;
END;

-- Every placeable thing with its full path, its ancestors, and the text
-- search runs over. The single source of truth for paths.
CREATE VIEW IF NOT EXISTS v_entities AS
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
LEFT JOIN locations l ON l.id = f.location_id;

-- Search: a plain table kept in step by the API (inside each write's
-- transaction), mirrored into an FTS5 index by triggers.
CREATE TABLE IF NOT EXISTS search_entries (
    id          INTEGER PRIMARY KEY,
    kind        TEXT    NOT NULL,
    ref_id      INTEGER NOT NULL,
    project_id  INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    location_id INTEGER,
    floor_id    INTEGER,
    room_id     INTEGER,
    rack_id     INTEGER,
    device_id   INTEGER,
    path        TEXT    NOT NULL,
    text        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_search_entries ON search_entries (kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_search_project ON search_entries (project_id);
CREATE INDEX IF NOT EXISTS idx_search_location ON search_entries (location_id);
CREATE INDEX IF NOT EXISTS idx_search_floor ON search_entries (floor_id);
CREATE INDEX IF NOT EXISTS idx_search_room ON search_entries (room_id);
CREATE INDEX IF NOT EXISTS idx_search_rack ON search_entries (rack_id);
CREATE INDEX IF NOT EXISTS idx_search_device ON search_entries (device_id);

-- '-', '_', '.' and ':' stay inside tokens, so "VIE-1", "core-sw-2.lan" and
-- MAC addresses are searchable as whole words or by prefix.
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    path, text,
    content = 'search_entries', content_rowid = 'id',
    tokenize = "unicode61 tokenchars '-_.:'"
);
CREATE TRIGGER IF NOT EXISTS search_entries_ai AFTER INSERT ON search_entries BEGIN
    INSERT INTO search_fts (rowid, path, text) VALUES (NEW.id, NEW.path, NEW.text);
END;
CREATE TRIGGER IF NOT EXISTS search_entries_ad AFTER DELETE ON search_entries BEGIN
    INSERT INTO search_fts (search_fts, rowid, path, text) VALUES ('delete', OLD.id, OLD.path, OLD.text);
END;
CREATE TRIGGER IF NOT EXISTS search_entries_au AFTER UPDATE ON search_entries BEGIN
    INSERT INTO search_fts (search_fts, rowid, path, text) VALUES ('delete', OLD.id, OLD.path, OLD.text);
    INSERT INTO search_fts (rowid, path, text) VALUES (NEW.id, NEW.path, NEW.text);
END;
