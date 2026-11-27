-- Rackpath v2, phase 1: users, roles, sessions, two-factor login,
-- invitations, projects and the audit log.
--
-- Conventions (see docs/design/v2-data-model.md, section 18):
--   * timestamps are UTC text in the fixed format YYYY-MM-DDTHH:MM:SS.sssZ,
--     so they sort and compare correctly as strings;
--   * enum-like columns are TEXT with a CHECK constraint;
--   * booleans are INTEGER 0/1 with a CHECK constraint.

CREATE TABLE IF NOT EXISTS users (
    id                    INTEGER PRIMARY KEY,
    username              TEXT    NOT NULL COLLATE NOCASE
                          CHECK (length(username) BETWEEN 1 AND 64),
    email                 TEXT    COLLATE NOCASE,
    display_name          TEXT,
    password_hash         TEXT    NOT NULL,
    must_change_password  INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
    totp_secret           TEXT,              -- encrypted ("v1:" format)
    totp_pending_secret   TEXT,              -- encrypted; set during enrolment
    totp_enabled          INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
    totp_last_step        INTEGER,           -- last accepted TOTP time step (replay protection)
    is_owner              INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
    disabled_at           TEXT,
    last_login_at         TEXT,
    created_at            TEXT    NOT NULL,
    updated_at            TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username ON users (username);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email ON users (email) WHERE email IS NOT NULL;
-- Exactly one owner at most.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_single_owner ON users (is_owner) WHERE is_owner = 1;

CREATE TABLE IF NOT EXISTS recovery_codes (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_hash  TEXT    NOT NULL,
    used_at    TEXT,
    created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recovery_codes_user ON recovery_codes (user_id);

CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY,
    code        TEXT NOT NULL
                CHECK (length(code) BETWEEN 1 AND 16 AND code NOT GLOB '*[^A-Z0-9._-]*'),
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
    description TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_code ON projects (code);

-- Role grants. project_id is the project the scope belongs to (NULL only for
-- account-wide grants); it is stored so "read is project-wide" checks and
-- listings don't need to walk the hierarchy.
CREATE TABLE IF NOT EXISTS role_grants (
    id          INTEGER PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role        TEXT    NOT NULL CHECK (role IN ('reader', 'editor', 'admin')),
    scope_type  TEXT    NOT NULL
                CHECK (scope_type IN ('account', 'project', 'location', 'floor', 'room', 'rack', 'device')),
    scope_id    INTEGER,
    project_id  INTEGER REFERENCES projects (id) ON DELETE CASCADE,
    created_by  INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at  TEXT    NOT NULL,
    CHECK ((scope_type = 'account') = (scope_id IS NULL)),
    CHECK ((scope_type = 'account') = (project_id IS NULL)),
    CHECK (scope_type <> 'project' OR scope_id = project_id),
    -- Reading is project-wide by design, so readers are granted at account
    -- or project level only.
    CHECK (role <> 'reader' OR scope_type IN ('account', 'project'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_role_grants
    ON role_grants (user_id, role, scope_type, COALESCE(scope_id, 0));
CREATE INDEX IF NOT EXISTS idx_role_grants_user ON role_grants (user_id);

CREATE TABLE IF NOT EXISTS sessions (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   TEXT    NOT NULL,
    created_at   TEXT    NOT NULL,
    last_seen_at TEXT    NOT NULL,
    expires_at   TEXT    NOT NULL,           -- absolute limit
    ip           TEXT,
    user_agent   TEXT,
    mfa_passed   INTEGER NOT NULL DEFAULT 0 CHECK (mfa_passed IN (0, 1))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_token ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS invitations (
    id               INTEGER PRIMARY KEY,
    email            TEXT,
    note             TEXT,
    grants           TEXT    NOT NULL CHECK (json_valid(grants)),
    token_hash       TEXT    NOT NULL,
    invited_by       INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at       TEXT    NOT NULL,
    expires_at       TEXT    NOT NULL,
    accepted_at      TEXT,
    accepted_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
    revoked_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_invitations_token ON invitations (token_hash);

CREATE TABLE IF NOT EXISTS account_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Change history. Written in the same transaction as the change it records.
-- project_id has no foreign key on purpose: history outlives deleted projects.
CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY,
    at            TEXT    NOT NULL,
    user_id       INTEGER REFERENCES users (id) ON DELETE SET NULL,
    username      TEXT,                      -- kept so entries stay readable after a user is deleted
    project_id    INTEGER,
    action        TEXT    NOT NULL CHECK (action IN (
                    'create', 'update', 'delete', 'move', 'connect', 'disconnect',
                    'login', 'login_failed', 'logout', 'grant', 'revoke',
                    'export', 'import', 'sync')),
    resource_type TEXT    NOT NULL,
    resource_id   INTEGER,
    resource_path TEXT,
    changes       TEXT    CHECK (changes IS NULL OR json_valid(changes)),
    request_id    TEXT,
    ip            TEXT,
    user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_project_at ON audit_log (project_id, at);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log (resource_type, resource_id, at);
CREATE INDEX IF NOT EXISTS idx_audit_user_at ON audit_log (user_id, at);

-- The audit log is append-only. Rows may only be deleted by retention.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
WHEN NOT (OLD.user_id IS NOT NULL AND NEW.user_id IS NULL
          AND NEW.id = OLD.id AND NEW.at = OLD.at AND NEW.action = OLD.action)
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;
