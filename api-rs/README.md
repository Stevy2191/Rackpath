# Rackpath v2 API (Rust)

The new Rackpath backend: one small program with its database in a single
SQLite file. It is being built in phases (see
[`docs/design/v2-data-model.md`](../docs/design/v2-data-model.md), section 21).
The v1 Node API in `api/` keeps serving the current frontend until phase 7.

**Status: phases 1 to 6 complete.**

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

- **Phase 5, library and power:** device templates (built-in and your
  own) with port layouts on a faceplate grid; devices made from them; safe
  template edits with a dry run; power cords, loads, A/B failover, UPS
  runtime and outlet use.

- **Phase 6, integrations and imports:** Windows DHCP/DNS (pushed by a
  PowerShell script, or an uploaded export file), UniFi Network (including
  its DHCP), UniFi Protect and Access, Zabbix, and CSV files; with
  ownership rules, missing-record tracking and held imports. Also device
  tags and topology diagrams.

The new frontend follows in phase 7.

## Running it

```bash
export RACKPATH_ENCRYPTION_KEY=$(openssl rand -hex 32)   # keep this safe: see below
cargo run --release
```

On first start it creates the owner account `admin` with a random temporary
password, printed once to the console. You must change it at first sign-in.

With Docker:

```bash
# from the repository root: builds the web app and the server into one image
docker build -t rackpath-v2 .
docker run -p 8080:8080 -v rackpath-data:/data -e RACKPATH_ENCRYPTION_KEY=... rackpath-v2
```

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `RACKPATH_ENCRYPTION_KEY` | **required** | 64 hex characters. Encrypts stored credentials (two-factor secrets and integration API keys, tokens and passwords). Same format and key as the v1 API. **Back it up with the database**: without it, two-factor secrets and integration credentials can't be read (users re-enrol; credentials are entered again) |
| `RACKPATH_DATA_DIR` | `./data` | Holds `rackpath.db` (and uploads in later phases) |
| `RACKPATH_DATABASE` | `<data dir>/rackpath.db` | Database file |
| `RACKPATH_BIND` | `0.0.0.0:8080` | Listen address |
| `RACKPATH_WEB_DIR` | `./web` (`/app/web` in the image) | The built web app (`web/dist`). Without it, only the API is served |
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
| Places | `GET /api/projects/{id}/places`: every location, floor, room and rack with its path, for pickers |
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
| Media catalog | `GET /api/media`: connectors, transceivers (with cage and speed) and cable types, for pickers |
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

## API overview (phase 5)

| Area | Endpoints |
|---|---|
| Templates | `GET/POST /api/projects/{id}/templates`, `GET/PUT/DELETE /api/templates/{id}` (`PUT ?dry_run=true`), `POST /api/templates/{id}/duplicate` |
| Template preview | `POST /api/projects/{id}/templates/preview`: checks a template and lists the ports it would make, without saving |
| Devices from templates | `POST /api/projects/{id}/devices` with `"template_id"` |
| Power figures | `GET/PUT /api/devices/{id}/power` |
| Power summary | `GET /api/racks/{id}/power` |
| Power cords | `POST /api/connections` with `"kind": "power"` |

**Templates:**
- **Built-ins** ship with Rackpath: 24/48-port switches, 24/48-port patch panels, a 24-port fibre panel, 1U/2U servers, a firewall, 1500 VA and 3000 VA UPSes, a battery module, horizontal and vertical PDUs, a wall outlet and an access point. They can't be edited; duplicate one into your project to change it.
- **Port groups** are rectangles of ports on the front or rear face: two port rows per U and 48 columns (a vertical PDU is a 120 × 4 strip). Each group has a prefix (up to 4 characters), a numbering order (`column_major`: 1 above 2, the usual switch layout; or `row_major`) and the port settings (connector, role, speed, PoE, outlet group…). Groups with the same prefix share one numbering sequence, left to right, front before rear. Individual ports can be renamed (`port_overrides`). Overlapping groups, groups off the face, more than 99 ports in a group and duplicate names are refused.
- **A device made from a template** gets its type, height, manufacturer, model, power figures and ports. Zero-U templates mount on the side automatically.
- **Editing a template** (`PUT`, which replaces the whole template) updates every device made from it in the same transaction:
  - ports are matched by code; ports that stay keep their cables, VLANs and addresses;
  - ports that disappear are deleted, with their cables;
  - a cable that no longer fits a changed port is removed;
  - a device that no longer fits its rack after growing moves to Unplaced;
  - manufacturer, model and each power figure follow the template unless the device's own value was changed;
  - an optic in a cage port stays as long as the cage type does.
  `?dry_run=true` returns exactly what would happen, per device, without changing anything. If anything would be removed or unplaced, the save needs `"confirm_name"` set to the template's name. Ports added by hand to a device never take part.
- **Deleting a template** leaves its devices and their ports in place, as ordinary ports.

**Power:**
- **Power ports** are ports with a power connector: outlets (C13, C15, C19, NEMA 5-15R/5-20R/L5-20R/L5-30R/L6-20R/L6-30R, Schuko socket, BS 1363 socket) or inlets and plugs (C14, C16, C20, the matching NEMA plugs, Schuko plug, BS 1363 plug), plus `Battery` and `DC`. Outlets can be numbered into `outlet_group` banks.
- **A power cord** is a `power` connection from an outlet to an inlet. Two outlets or two inlets are refused; different families (a C19 outlet to a C14 inlet) are allowed with a warning to check the cord. `Battery` ports connect only to each other (UPS to battery module).
- **Power figures** per device: `typical_w` and `max_w` (draw), `capacity_va`, `capacity_w`, `input_voltage`, and for UPSes a `runtime_curve` and for battery modules an `ebm_runtime_curve` (points of `load_w` and `minutes`), plus `max_ebm_slots`.
- **The power summary** for a rack lists every device with power: its draw, what it delivers through its outlets (a device with two connected inlets splits its draw between them), the **failover load** if its partner feed fails (it then carries everything it feeds in full), load percentages, UPS runtime at the current and failover load (battery modules add their curves), outlets used per bank, and warnings: overloaded, above 80%, can't carry its redundant loads alone, no cord on any inlet, only one of several inlets connected, too many battery modules, draw not recorded. Feeds from other racks count. Rack totals include UPS capacity and what's left if the largest UPS fails (N+1).

## API overview (phase 6)

| Area | Endpoints |
|---|---|
| Integrations | `GET/POST /api/projects/{id}/integrations`, `GET/PATCH/DELETE /api/integrations/{id}` |
| Running them | `POST /api/integrations/{id}/test`, `POST /api/integrations/{id}/sync` (`?dry_run=true`), `GET /api/integrations/{id}/runs` |
| Held imports | `POST /api/integrations/{id}/runs/{run}/approve`, `.../reject` |
| Windows DHCP/DNS | `POST /api/imports/windows-dhcp` (import token), `POST /api/integrations/{id}/upload` (XML export), `POST /api/integrations/{id}/rotate-token` |
| CSV | `POST /api/projects/{id}/import/csv?kind=devices\|ports\|connections\|prefixes\|ranges\|addresses&dry_run=true` |
| Tags | `GET/POST /api/projects/{id}/tags`, `PATCH/DELETE /api/tags/{id}`, `PUT /api/devices/{id}/tags`, `?tag=` on device lists |
| Diagrams | `GET/POST /api/projects/{id}/topologies`, `GET/PUT/DELETE /api/topologies/{id}` |

**Integrations read; they never contact devices or change anything at the source.**

| Source | How | What comes in |
|---|---|---|
| **Windows DHCP/DNS** | `tools/windows/Push-RackpathDhcp.ps1` pushes hourly (see [its README](../tools/windows/README.md)), or upload `Export-DhcpServer` XML | Scopes → prefixes (gateway, DNS servers, domain); DHCP range → DHCP pool split around exclusions; exclusions → reserved ranges; reservations → reserved addresses linked to the device with that MAC; static DNS A/AAAA/PTR → DNS names and aliases; optionally leases |
| **UniFi Network** | API key (local console address) or local username/password | Gateways, switches and access points with their IPs; networks → VLANs and prefixes with gateway; unless `import_dhcp` is off, each network's DHCP range and DNS servers, and clients with a fixed IP as reservations; optionally connected clients as the lease layer |
| **UniFi Protect / Access** | Same | Cameras; Access hubs and readers |
| **Zabbix** | API token (recommended) or username/password | Hosts → devices with their interface IPs, inventory vendor/model/serial/MAC, and an "Open in Zabbix" link. No monitoring data |
| **CSV** | Upload | Devices (by room/rack path, optional template), ports, connections, prefixes, ranges, addresses |

**Ownership rules:**
- **An import owns only the facts it brings** (for a device: hostname, MAC, manufacturer, model, serial, firmware; for an address: MAC, DNS names, reservation flag). Codes, names you gave, placement, notes, roles and links are yours and never overwritten.
- **Matching:** by integration and external id, so syncs update rather than duplicate. A hand-made device with the same MAC, a prefix with the same CIDR or an address already documented is adopted, not duplicated.
- **Gone at the source:** marked `missing_from_source_at` and listed in the IPAM warnings. Nothing is deleted automatically.
- **Held imports:** if a sync would change more than `hold_threshold_pct` (default 50%) of the records the integration owns (and it owns at least 10), it's held; an admin approves or rejects it.
- **Every sync** is one transaction and one grouped `sync` entry in the change history. `?dry_run=true` shows the result without saving.
- **Leases** are a separate layer, replaced on every import, shown on the address grid, and never turned into documentation automatically.
- **Secrets** (API keys, tokens, passwords) are encrypted with `RACKPATH_ENCRYPTION_KEY` and never returned. The Windows import token is shown once and stored as a hash; one push per minute per token; bodies up to 20 MB (gzip accepted).
- **Automatic syncs:** UniFi and Zabbix integrations with `auto_sync` run every `sync_interval_minutes` (default 60).
- **Permissions:** project admins manage integrations; anyone who can read the project sees them (without secrets). CSV rows need the same rights as the API calls they make.

**CSV import** checks every row with the same rules as the API, in one transaction: if any row fails, nothing is saved and the errors are listed by row number. Paths are relative to the project (`HQ/2/MDF/RK01/SW01/24`; the project code in front is optional). Unknown columns are refused.

**Diagrams** are saved whole (`PUT`), with `expected_version` to stop two people overwriting each other. Nodes can stand for devices; an edge can be backed by a cable, and then shows the cable's ends and chain state.

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
