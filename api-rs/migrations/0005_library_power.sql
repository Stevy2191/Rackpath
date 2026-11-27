-- Rackpath v2, phase 5: device templates and power. See
-- docs/design/v2-data-model.md sections 7 and 8.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS; sqlx runs each migration exactly
-- once, so plain ADD COLUMN is safe here.

-- Templates. project_id NULL = a built-in that ships with Rackpath (seeded
-- at start, never edited; "duplicate" copies it into a project). The
-- device type is referenced by key, so built-ins work in every project.
CREATE TABLE IF NOT EXISTS device_templates (
    id                INTEGER PRIMARY KEY,
    project_id        INTEGER REFERENCES projects (id) ON DELETE CASCADE,
    builtin_key       TEXT,
    name              TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    device_type_key   TEXT    NOT NULL,
    manufacturer      TEXT,
    model             TEXT,
    -- Half-U steps; 0 = zero-U (vertical PDU); NULL = not rack-mounted.
    u_height_half     INTEGER CHECK (u_height_half IS NULL OR u_height_half BETWEEN 0 AND 120),
    depth             TEXT    CHECK (depth IS NULL OR depth IN ('half', 'full')),
    half_width        INTEGER NOT NULL DEFAULT 0 CHECK (half_width IN (0, 1)),
    -- Power figures, copied to devices made from the template.
    input_voltage     TEXT,
    capacity_va       INTEGER CHECK (capacity_va IS NULL OR capacity_va >= 0),
    capacity_w        INTEGER CHECK (capacity_w IS NULL OR capacity_w >= 0),
    typical_w         INTEGER CHECK (typical_w IS NULL OR typical_w >= 0),
    max_w             INTEGER CHECK (max_w IS NULL OR max_w >= 0),
    runtime_curve     TEXT    CHECK (runtime_curve IS NULL OR json_valid(runtime_curve)),
    ebm_runtime_curve TEXT    CHECK (ebm_runtime_curve IS NULL OR json_valid(ebm_runtime_curve)),
    max_ebm_slots     INTEGER CHECK (max_ebm_slots IS NULL OR max_ebm_slots >= 0),
    notes             TEXT,
    version           INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL,
    CHECK ((project_id IS NULL) = (builtin_key IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_templates_name ON device_templates (project_id, name) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_device_templates_builtin ON device_templates (builtin_key) WHERE builtin_key IS NOT NULL;

-- A rectangle of ports on one face; two port rows per U, 48 columns.
CREATE TABLE IF NOT EXISTS template_port_groups (
    id                 INTEGER PRIMARY KEY,
    template_id        INTEGER NOT NULL REFERENCES device_templates (id) ON DELETE CASCADE,
    position           INTEGER NOT NULL,
    face               TEXT    NOT NULL CHECK (face IN ('front', 'rear')),
    grid_row           INTEGER NOT NULL CHECK (grid_row >= 0),
    grid_col           INTEGER NOT NULL CHECK (grid_col >= 0),
    rows               INTEGER NOT NULL CHECK (rows >= 1),
    cols               INTEGER NOT NULL CHECK (cols >= 1),
    prefix             TEXT    NOT NULL DEFAULT '' CHECK (length(prefix) <= 4),
    numbering          TEXT    NOT NULL DEFAULT 'column_major' CHECK (numbering IN ('column_major', 'row_major')),
    start_number       INTEGER NOT NULL DEFAULT 1 CHECK (start_number BETWEEN 0 AND 99999),
    -- Applied to every port of the group (connector, medium, role… follow
    -- the same rules as ports; transceiver, speed, PoE and description are
    -- starting values for new ports only).
    medium             TEXT,
    connector          TEXT,
    transceiver        TEXT,
    fiber_mode         TEXT,
    role               TEXT    CHECK (role IS NULL OR role IN ('active', 'passive')),
    requires_permanent INTEGER NOT NULL DEFAULT 1 CHECK (requires_permanent IN (0, 1)),
    speed              INTEGER,
    poe                TEXT,
    outlet_group       INTEGER,
    description        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_template_port_groups ON template_port_groups (template_id, position);

-- A custom name for one generated port (by generation order).
CREATE TABLE IF NOT EXISTS template_port_overrides (
    template_id INTEGER NOT NULL REFERENCES device_templates (id) ON DELETE CASCADE,
    port_index  INTEGER NOT NULL CHECK (port_index >= 0),
    code        TEXT    NOT NULL CHECK (length(code) BETWEEN 1 AND 10),
    PRIMARY KEY (template_id, port_index)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_template_port_overrides_code ON template_port_overrides (template_id, code);

-- Labels and icons drawn on a faceplate.
CREATE TABLE IF NOT EXISTS template_elements (
    id          INTEGER PRIMARY KEY,
    template_id INTEGER NOT NULL REFERENCES device_templates (id) ON DELETE CASCADE,
    position    INTEGER NOT NULL,
    face        TEXT    NOT NULL CHECK (face IN ('front', 'rear')),
    kind        TEXT    NOT NULL CHECK (kind IN ('text', 'icon')),
    grid_row    INTEGER NOT NULL CHECK (grid_row >= 0),
    grid_col    INTEGER NOT NULL CHECK (grid_col >= 0),
    rows        INTEGER NOT NULL CHECK (rows >= 1),
    cols        INTEGER NOT NULL CHECK (cols >= 1),
    text        TEXT    CHECK (text IS NULL OR length(text) <= 100),
    align       TEXT    CHECK (align IS NULL OR align IN ('left', 'center', 'right')),
    highlighted INTEGER NOT NULL DEFAULT 0 CHECK (highlighted IN (0, 1)),
    icon        TEXT
);
CREATE INDEX IF NOT EXISTS idx_template_elements ON template_elements (template_id, position);

ALTER TABLE devices ADD COLUMN template_id INTEGER REFERENCES device_templates (id) ON DELETE SET NULL;
ALTER TABLE devices ADD COLUMN template_version INTEGER;
CREATE INDEX IF NOT EXISTS idx_devices_template ON devices (template_id);

-- Ports made by a template take part in template updates; ports added by
-- hand never do.
ALTER TABLE ports ADD COLUMN from_template INTEGER NOT NULL DEFAULT 0 CHECK (from_template IN (0, 1));
ALTER TABLE ports ADD COLUMN outlet_group INTEGER CHECK (outlet_group IS NULL OR outlet_group BETWEEN 1 AND 99);

-- Power figures for a device (1:1, only when recorded). Curves are JSON
-- arrays of {"load_w": …, "minutes": …}.
CREATE TABLE IF NOT EXISTS device_power (
    device_id         INTEGER PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
    input_voltage     TEXT,
    capacity_va       INTEGER CHECK (capacity_va IS NULL OR capacity_va >= 0),
    capacity_w        INTEGER CHECK (capacity_w IS NULL OR capacity_w >= 0),
    typical_w         INTEGER CHECK (typical_w IS NULL OR typical_w >= 0),
    max_w             INTEGER CHECK (max_w IS NULL OR max_w >= 0),
    runtime_curve     TEXT    CHECK (runtime_curve IS NULL OR json_valid(runtime_curve)),
    ebm_runtime_curve TEXT    CHECK (ebm_runtime_curve IS NULL OR json_valid(ebm_runtime_curve)),
    max_ebm_slots     INTEGER CHECK (max_ebm_slots IS NULL OR max_ebm_slots >= 0),
    updated_at        TEXT    NOT NULL
);
