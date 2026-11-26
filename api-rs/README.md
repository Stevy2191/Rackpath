# Rackpath v2 API (Rust)

The new Rackpath backend: one small program with its database in a single
SQLite file. It is being built in phases (see
[`docs/design/v2-data-model.md`](../docs/design/v2-data-model.md), section 21).
The v1 Node API in `api/` keeps serving the current frontend until phase 7.

**Status: phase 1 (security core) complete.** Users, roles and scoped
permissions, server-side sessions, two-factor login, invitations, projects,
account settings and the change history. Locations, racks, devices and
everything else follow in later phases.

## Running it

```bash
export RACKPATH_ENCRYPTION_KEY=$(openssl rand -hex 32)   # keep this safe: see below
cargo run --release
```

On first start it creates the owner account `admin` with a random temporary
password, printed once to the console. You must change it at first sign-in.

With Docker:

```bash
docker build -t rackpath-v2 .
docker run -p 8080:8080 -v rackpath-data:/data -e RACKPATH_ENCRYPTION_KEY=... rackpath-v2
```

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `RACKPATH_ENCRYPTION_KEY` | **required** | 64 hex characters. Encrypts stored credentials (two-factor secrets now; integration logins later). Same format and key as the v1 API. **Back it up with the database**: without it, two-factor secrets can't be read and users must re-enrol |
| `RACKPATH_DATA_DIR` | `./data` | Holds `rackpath.db` (and uploads in later phases) |
| `RACKPATH_DATABASE` | `<data dir>/rackpath.db` | Database file |
| `RACKPATH_BIND` | `0.0.0.0:8080` | Listen address |
| `RACKPATH_PUBLIC_URL` | none | e.g. `https://rackpath.example.com`. Used for invitation links |
| `RACKPATH_COOKIE_SECURE` | `false` | Set `true` when served over HTTPS |
| `RACKPATH_TRUST_PROXY` | `false` | Take the client IP from `X-Forwarded-For` (only behind your own reverse proxy) |
| `RACKPATH_AUDIT_RETENTION_DAYS` | keep forever | Delete change history older than this |
| `RACKPATH_LOG` | `info` | Log filter, e.g. `debug` |

The process refuses to start with a missing or malformed required setting.

### Command line

```bash
rackpath                         # same as: rackpath serve
rackpath reset-password admin    # new temporary password; signs the user out everywhere
rackpath backup /backups/rp.db   # consistent copy, safe while the server runs
rackpath version
```

## Security model (phase 1)

- **Passwords:** argon2id; at least 10 characters. v1 bcrypt hashes are accepted once and upgraded.
- **Failed logins:** generic answer, recorded, and limited to 10 per username and 50 per IP every 15 minutes.
- **Sessions:**
  - stored server-side, keyed by the SHA-256 of a 256-bit random token in an `HttpOnly; SameSite=Strict` cookie;
  - expire after 12 hours idle or 7 days in total;
  - can be revoked instantly;
  - the token is replaced after a password change or a two-factor step;
  - changing a password signs out every other session.
- **First sign-in:** until the password is changed, only "me", change password and log out work.
- **Two-factor login:**
  - TOTP, with a QR link for authenticator apps;
  - a code can't be reused, and codes are limited to 10 attempts per 15 minutes;
  - 10 single-use recovery codes, stored hashed;
  - the secret is encrypted at rest;
  - admins can require it for the whole account.
- **Permissions:** reader, editor and admin, granted account-wide or per project (and, from phase 2, down to a location, room, rack or device).
  - Reading is project-wide; edit rights cascade down from the scope they were given at.
  - Admins can only grant within their own scope.
  - The rules are pure functions with exhaustive unit tests (`src/domain/permissions.rs`).
  - Things you can't read answer 404, so their existence isn't revealed.
- **Owner:** one owner who can't be disabled, deleted or reset by anyone else; ownership can be transferred.
- **Invitations:**
  - single-use links, valid 7 days, stored hashed;
  - the grants are re-checked against the inviter's current rights when accepted;
  - no email is sent, so no mail server is needed.
- **Change history:**
  - every change is written in the same transaction as the change;
  - the database refuses edits to history;
  - entries keep the username after a user is deleted;
  - visible to the people who can read the project.
- **Requests:**
  - state-changing requests from another site are refused (Origin / `Sec-Fetch-Site` check, on top of SameSite cookies);
  - 1 MB body limit and strict security headers;
  - error responses never include internal details.
- **SQL:** only compile-time literal SQL strings are accepted (enforced by sqlx 0.9), with bound parameters.

## Development

```bash
cargo test                              # unit tests + end-to-end tests against temporary databases
cargo clippy --all-targets -- -D warnings
cargo fmt
cargo audit                             # dependency advisories (cargo install cargo-audit)
```

Migrations live in `migrations/`, numbered `0001_…`, and are applied
automatically at start. The same rules as v1 apply (see `CLAUDE.md`): every
schema change ships with a new migration in the same commit, and existing
migrations are never edited.
