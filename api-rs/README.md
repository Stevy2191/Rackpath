# Rackpath v2 API (Rust)

The new Rackpath backend: one small program with its database in a single
SQLite file. It is being built in phases (see
[`docs/design/v2-data-model.md`](../docs/design/v2-data-model.md), section 21).
The v1 Node API in `api/` keeps serving the current frontend until phase 7.

**Status: phases 1 to 4 complete.**

- **Phase 1, security core:** users, roles and scoped permissions,
  server-side sessions, two-factor login, invitations, projects, account
  settings and the change history.
- **Phase 2, hierarchy and naming:** locations, floors, rooms, racks,
  device types and devices; full paths like `ACME/HQ/2/MDF/RK01/SW02`; the
  Unplaced list; rack fit checks; global search. Grants can be given on a
    location, floor, room, rack or single device.
- **Phase 3, ports and cabling:** ports with connectors, transceivers and
  cable types; cables between port sides with the patch/permanent rules;
  chain tracing with complete/incomplete states; checks for cables that
  can't fit or probably won't work; chain colours; VLANs and WLANs.

- **Phase 4, IP address management:** address spaces, prefixes (nested
  automatically), DHCP pools and other ranges, addresses on devices and
  ports, next free address, the address grid, plan warnings, and search by
  address or DNS name.

Templates and power follow in phase 5; integrations and imports in phase 6.

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
- **Password hashing** runs on a separate thread pool, at most two at a time, so it never stalls other requests and a burst of login attempts can't exhaust memory.

## API overview (phase 2)

| Area | Endpoints |
|---|---|
| Locations | `GET/POST /api/projects/{id}/locations`, `GET/PATCH/DELETE /api/locations/{id}` |
| Floors | `POST /api/locations/{id}/floors`, `GET/PATCH/DELETE /api/floors/{id}` |
| Rooms | `POST /api/floors/{id}/rooms`, `GET/PATCH/DELETE /api/rooms/{id}` |
| Racks | `POST /api/rooms/{id}/racks`, `GET/PATCH/DELETE /api/racks/{id}` |
| Device types | `GET/POST /api/projects/{id}/device-types`, `PATCH/DELETE /api/device-types/{id}` |
| Devices | `GET/POST /api/projects/{id}/devices`, `GET/PATCH/DELETE /api/devices/{id}` |
| Codes | `GET /api/projects/{id}/next-code?device_type_id=…&room_id=…` (or `rack_id`, `tray_id`; `kind=rack` for racks) |
| Search | `GET /api/search?q=…&project_id=…&kind=device` |

**How the hierarchy behaves:**
- **Defaults:** a new location gets floor `0`, and every floor gets a `DEFAULT` room, so devices can be placed before any rooms are drawn.
- **Codes:** uppercase, 1–16 characters, unique among siblings. Racks and floor devices share a room's namespace. When no code is given, one is generated from the type prefix (`SW01`, `SW02`, …), and a clash suggests a free alternative.
- **Placement:** a device sits in a room (with optional floor-plan x/y), in a rack (U position in half-U steps, front/rear/full depth, full or half width, or zero-U), on a tray, or in the project's Unplaced list. Types only go where they make sense: a switch can't go on a floor, an access point can't go in a rack.
- **Moving:** a device can only be moved by someone who can edit both where it is and where it's going.
- **Deleting a container that still holds devices** needs `"devices": "unplace"` (they move to Unplaced, renamed if their code is taken there) or `"devices": "delete"`, plus `"confirm_code"`.
- **Updates:** omitted fields are unchanged. For text fields `""` clears; for numbers, dates and the responsible user, `null` clears.

## API overview (phase 3)

| Area | Endpoints |
|---|---|
| Ports | `GET/POST /api/devices/{id}/ports`, `POST /api/devices/{id}/ports/bulk`, `GET/PATCH/DELETE /api/ports/{id}` |
| Rack patching view | `GET /api/racks/{id}/ports` (every port with both cables, VLANs and chain state) |
| Cables | `POST /api/connections`, `GET/PATCH/DELETE /api/connections/{id}` |
| Chains | `GET /api/ports/{id}/trace`, `POST /api/ports/{id}/chain-color` |
| VLANs | `GET/POST /api/projects/{id}/vlans`, `PATCH/DELETE /api/vlans/{id}`, `PUT /api/ports/{id}/vlans` |
| WLANs | `GET/POST /api/projects/{id}/wlans`, `PATCH/DELETE /api/wlans/{id}` |
| Search | `GET /api/search?q=…&kind=port` (ports are only searched when asked for) |

**What's recorded where:**
- **On the port:** its `connector` (RJ45, RJ11, SFP, SFP+, SFP28, QSFP+,
  QSFP28, LC, SC, ST, E2000, MPO, DB9, USB, F, BNC, Other) and, for SFP and
  QSFP cages, the `transceiver` plugged in (1000BASE-T/SX/LX/ZX/BX,
  10GBASE-T/SR/LR/ER/BX, 25GBASE-SR/LR, 40GBASE-SR4/LR4, 100GBASE-SR4/LR4).
  A module must fit its cage: a 10G SFP+ module can't go in a 1G SFP port.
  `medium` (copper, fiber, wireless, console, coax, other) follows from
  these. Also `speed` (Mb/s), `poe`, `interface_name` (e.g. `Gi1/0/24`), MAC,
  and for wireless ports the WLAN.
- **On the cable:** `cable_type` (Cat3, Cat5, Cat5e, Cat6, Cat6a, Cat7, Cat8,
  OM1–OM5, OS1, OS2, DAC/AOC SFP+, SFP28, QSFP+, QSFP28, Console, USB, Coax,
  Other), `length_m`, `color`, `label`, `notes`.

**Cabling rules:**
- **Ports are active or passive.** Active ports (switch ports, NICs) have one side. Passive ports (patch-panel ports, wall outlets) have a `front` for patch cords and a `rear` for the permanent cable. Panel and outlet ports are passive by default.
- **Permanent cables** join the rear sides of passive ports; **patch cables** join front sides. A panel port can't be patched until its rear is cabled, unless the port has `requires_permanent: false` (couplers).
- **One cable per port side**, enforced by the database. Deleting a port or device removes its cables.
- **Refused:** combinations that can't physically be joined, e.g. RJ45 to LC, a fibre cable on a copper port, a QSFP DAC in an SFP+ port, a DAC into a port that holds an optic, an empty SFP cage to anything but a DAC/AOC, a cable to a wireless port.
- **Accepted with `warnings`:** single-mode cable on a multimode optic (or the reverse), an SR optic facing an LR optic, optics of different speeds, Cat5e at 10G, Cat6 at 10G over about 55 m, copper over 100 m, multimode runs longer than the optic reaches at that speed, a faster DAC in a slower cage.
- **Tracing** follows cables through passive ports in both directions (at most 64 hops). A chain is **complete** when both ends are active ports, **incomplete** otherwise, **unconnected** with no cables. The trace lists every port and cable in order, the total length, and the same warnings checked at the chain's real link speed.
- **Moving devices:** cables stay when a device or rack moves within its floor. Moving to another floor removes the cables to anything that isn't moving with it. Unplaced devices can't be cabled, so unplacing one removes its cables. Every removed cable is listed in the change history.
- **Permissions:** anyone who can edit either end of a cable can add, change or remove it. Ports need edit rights on their device; VLANs and WLANs on the project.
- **WLANs never store a passphrase**; a request that includes one is refused.

## API overview (phase 4)

| Area | Endpoints |
|---|---|
| Address spaces | `GET/POST /api/projects/{id}/spaces`, `PATCH/DELETE /api/spaces/{id}` |
| Prefixes | `GET/POST /api/projects/{id}/prefixes`, `GET/PATCH/DELETE /api/prefixes/{id}` |
| Next free, grid | `GET /api/prefixes/{id}/next-free?count=&range_id=`, `GET /api/prefixes/{id}/grid` |
| Ranges | `POST /api/prefixes/{id}/ranges`, `PATCH/DELETE /api/ranges/{id}` |
| Addresses | `GET/POST /api/projects/{id}/addresses`, `GET/PATCH/DELETE /api/addresses/{id}` |
| Warnings | `GET /api/projects/{id}/ipam/warnings` |
| Search | `GET /api/search?q=10.20.30` (also `kind=prefix` or `kind=address`) |

**How it behaves:**
- **IPAM records the plan; it never pings or scans.** IPv4 and IPv6 throughout.
- **Spaces:** every project has `Default`. Add another only when the same private range really exists twice (separate routing domains).
- **Prefixes** are written as CIDR (`10.20.30.0/24`); host bits must be zero (`10.20.30.7/24` is refused with "did you mean 10.20.30.0/24?"). Nesting is computed: a prefix's parent is the smallest prefix containing it. Each has a role, status, optional VLAN, location, gateway, DNS servers and domain.
- **Ranges** (`dhcp_pool`, `reserved`, `static`) sit inside one prefix and don't overlap.
- **Addresses** belong to the smallest prefix containing them. Give `port_id` (the device follows) or `device_id`, or neither for a documented spare. Omit `address` and give `prefix_id` to take the next free one. The network and broadcast addresses are refused.
- **Next free** skips documented addresses, DHCP pools, reserved ranges, the gateway, and the network and broadcast addresses. `range_id` looks inside one range, e.g. your static range.
- **The grid** (IPv4 up to /22) returns offsets for the network, broadcast, gateway, ranges and addresses, for drawing one cell per address.
- **Warnings** (on save and in the warnings list): an address outside every prefix; a static address inside a DHCP pool; the same MAC on two DHCP reservations; a port's address in a prefix whose VLAN isn't on that port; a users/servers/voice/printers/IoT prefix without a VLAN; records missing from their import source.
- **Deleting** a device or port keeps its addresses, unassigned. Deleting a prefix removes its ranges and keeps the addresses.
- **Permissions:** prefixes on a location need edit rights on that location (otherwise on the project); ranges follow their prefix; an address on a device needs edit rights on that device (otherwise on the project). Reading is project-wide.

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
