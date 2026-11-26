# Rackpath v2: data model and API design

Status: **approved direction; decisions D1–D5 resolved (section 19)**. Nothing here is built yet.

This document designs the data model for Rackpath v2. That release:

- rebuilds the API in Rust;
- adds physical-layer documentation: buildings, floors, floor plans, cabling and patching, a device template designer, users and roles, a full change history, exports, and cross-site search.

Features and ideas were taken from reviewing Patchdocs. None of its text, design or code is reused, and features tied to its own hardware (patchbox.one cassettes) are left out.

**Rackpath is documentation software.** It records what exists and how it's connected. It does not probe, poll or monitor the network, and it stores no device logins. Network scanning, network tools, credential macros, SNMP polling and live state from integrations were removed from v1 in the same spirit (migration 0067), and none of them come back in v2.

What stays from v1: inventory-only integrations, the logical topology diagram, UPS and power planning, VLANs, tags and self-hosting.

Decisions taken by the project owner are recorded in section 19.

---

## 1. Goals and non-goals

**Goals**

1. **Every physical thing has exactly one place.** That place is a location, floor, room, rack or tray. A short ID path names it, such as `HQ/2/MDF/RK01/SW02/13`. Someone reading the path knows where to walk.
2. **Every cable is recorded and every path can be traced.** It is clear whether a cable is permanent building cabling or a movable patch cord. A path is traced end to end through patch panels and wall outlets, and is reported as complete or incomplete.
3. **One device table.** Inventory items, rack-mounted equipment, cameras, access-control hardware, PDUs and UPSes are all devices. Type-specific details live in extension tables.
4. **Real users.** Each user has a role. Edit rights can be narrowed to a location, room, rack or single device. Two-factor login is available. Every change is recorded with who made it.
5. **Built for Rust.** The schema is strict (types, constraints, foreign keys) so the database enforces it, rather than relying on application code to.

**Non-goals for v2**

- Fibre breakout cables (MPO to LC fan-outs) with per-strand tracing. They are recorded as single ports, with a note. See Open questions.
- Electrical circuits upstream of the rack (panels, breakers).
- **Anything that touches the network or watches it:** scanning, SNMP or SSH polling, ping/traceroute tools, up/down status, port link state, live door or camera state. Rackpath is not a monitoring system and has no component that sends traffic to devices.
- **Storing device credentials** (SNMP communities, SSH/HTTP logins, camera stream passwords, Wi-Fi passphrases). A note on a device can point to the entry in your password manager. The only secrets Rackpath stores are the logins and API keys for its own integrations.
- **Outside services by default:** no map tiles, geocoding, or MAC-vendor lookups.
- Hosted multi-company billing. "Pay per rack" has no meaning for self-hosted software.

---

## 2. Hierarchy

```
Account (the installation)
└── Project            (a customer or organisation; the isolation boundary)
    ├── Location       (a building or site)
    │   └── Floor      (one 2D plan; a storey, a yard, a container…)
    │       └── Room   (an area drawn on the plan; every floor has a DEFAULT room)
    │           ├── Device      (on the floor: AP, camera, outlet, printer, desk…)
    │           │   └── Port ── Connection
    │           └── Rack
    │               ├── Device  (rack-mounted: switch, patch panel, server, PDU, UPS…)
    │               │   └── Port ── Connection
    │               └── Device of kind "tray" (a shelf)
    │                   └── Device  (sitting on the shelf)
    │                       └── Port ── Connection
    ├── Unplaced devices (imported by integrations or CSV, not yet given a place)
    ├── VLANs, WLANs, device types, device templates
    ├── Topology diagrams (the logical view; unchanged in concept)
    └── Integrations (inventory import only)
```

**A project is the isolation boundary, like a "tenant".** The UI keeps the word "Project". Nothing crosses a project boundary: networks, templates and permissions are all project-scoped, except account-wide grants.

**Every floor gets a DEFAULT room automatically.** Devices placed where no room is drawn belong to it, so drawing rooms is optional.

**Unplaced devices** are new compared with Patchdocs, and they're needed because Rackpath imports equipment. Integration syncs and CSV imports land devices here. Someone then places them, by dragging onto a floor plan, into a rack, or choosing a room. Until then their path is `<PROJECT>/UNPLACED/<ID>`.

---

## 3. Naming scheme

Every placeable thing has two names:

| Field | Purpose | Rules |
|---|---|---|
| `code` | Short ID that builds the path | Required. Uppercase letters, digits, `.`, `_` and `-`; starts with a letter or digit; 1–16 characters; no spaces. Input is uppercased on save. **Unique within its parent.** |
| `name` | Human-readable label | Optional, up to 255 characters. Put old labels or hostnames from a spreadsheet here so search still finds them. |

**Full path** = the codes joined with `/` from the project down:

```
ACME / HQ / 2 / MDF / RK01 / SW02 / 13
 project loc floor room rack device port
```

Floor devices skip the rack segment (`ACME/HQ/2/OFFICE/AP01/01`). Tray devices add the tray (`…/RK01/TR01/MC01/01`).

The path is **computed, never stored as the source of truth**. Renaming a room renames every path below it, with no data migration. A denormalised, indexed `search_path` column is kept in sync for search (section 13).

**Device types and prefixes.** Each project has a `device_types` table, seeded from built-in defaults that can be customised. New devices get `prefix + next free two-digit number`, unique within the parent: `SW01`, `SW02`, and so on. The user can overwrite it. Changing a prefix affects only new devices.

Built-in device types:

| Placement | Types (prefix) |
|---|---|
| Floor | Access point (AP), Camera (CAM), Desktop (DP), Laptop (LP), Phone (PH), Printer (PR), Screen (SCR), Wall/telecom outlet (TO), ISP handoff (ISP), Access-control panel (ACP), Door reader (RDR), IoT/other (IOT) |
| Rack | Switch (SW), Router (RT), Firewall (FW), Server (SRV), NAS (NAS), Patch panel (PP), Fibre panel (FP), Cable manager (CM), Blanking panel (BLK), PDU (PDU), UPS (UPS), Battery module (EBM), Shelf/tray (TR), KVM (KVM), Miscellaneous (MISC) |
| Either | Media converter (MC), Modem (MDM), Misc (MISC) |

Each integration's device kinds (UniFi `usw`/`uap`/`ugw`, NetBox roles, LibreNMS and Zabbix groups) map onto these when devices are imported.

**Network identity stays separate.** `hostname`, `ip`, `mac` and similar fields are device attributes, not the code. A switch can be `SW02` in the documentation and `core-sw-2.acme.lan` on the network.

---

## 4. Locations, floors and rooms

### locations
| Column | Type | Notes |
|---|---|---|
| id | bigint PK | |
| project_id | FK projects | |
| code, name | | Unique `(project_id, code)` |
| address_street, address_city, address_state, address_postcode, address_country | text | |
| contact_name, contact_phone, contact_email | text | |
| responsible_user_id | FK users null | |
| isp_primary_name, isp_primary_circuit, isp_primary_contact, isp_secondary_… | text | **Moved here from projects:** they describe a site |
| wan_ip, wan_subnet, wan_gateway, lan_ip, lan_subnet, lan_gateway, dns_servers | text | Also moved from projects |
| notes | text | |

### floors
| Column | Type | Notes |
|---|---|---|
| id, location_id | | |
| code, name | | Unique `(location_id, code)`. Codes are usually numbers: `0`, `1`, `2`, `B1` |
| level | int | Sort order. Unique `(location_id, level)` |
| plan_attachment_id | FK attachments null | The floor plan image (PNG, JPEG, WebP or PDF first page; section 12) |
| plan_width, plan_height | int null | Image size in pixels. All coordinates on the floor use these units |
| scale_px_per_m | decimal null | Set by the "measure a known distance" tool; lets the UI show metres |

A location must always keep at least one floor. Creating a location creates floor `0`.

### rooms
| Column | Type | Notes |
|---|---|---|
| id, floor_id | | |
| code, name | | Unique `(floor_id, code)`. `DEFAULT` is reserved and created with every floor |
| shape | JSON null | `{"type":"polygon","points":[[x,y],…]}` in plan pixels. A rectangle is a 4-point polygon. NULL only for DEFAULT |
| color | text null | |
| contact_name, contact_phone, contact_email, responsible_user_id, notes | | |

**Rooms may overlap**, for example a server room inside an open office. Which room a device belongs to is **stored on the device**, never worked out from its position.

When a device is dropped where rooms overlap, the UI asks and suggests the smallest room. When a room's shape changes, the API returns the devices now outside their room's outline and the devices now inside a room they don't belong to. The UI asks about each; positions never move by themselves.

---

## 5. Devices (one table for every physical thing)

### devices
| Column | Type | Notes |
|---|---|---|
| id, project_id | | |
| device_type_id | FK device_types | Carries the prefix and category |
| template_id | FK device_templates null | The template it was built from (section 7). NULL means a free-form device |
| code, name | | Unique among siblings. See *parent key* below |
| **Placement** (exactly one of the following groups; enforced by a CHECK constraint) | | |
| room_id + plan_x, plan_y, plan_rotation | | Floor device. Position is NULL when the floor has no plan or the device isn't pinned yet |
| rack_id + rack_u, rack_face, rack_mount | | Rack device. `rack_u` = lowest U occupied; `rack_face` ∈ front, rear, both (full depth); `rack_mount` ∈ full_width, half_left, half_right, zero_u_left, zero_u_right; plus `zero_u_position` for vertical PDUs |
| parent_device_id | | Tray device: sits on a device whose type is tray |
| *(none of the above)* | | Unplaced |
| u_height | decimal(3,1) null | Rack devices only. Half-U steps are allowed, matching the current `position_offset` |
| depth | enum half, full null | |
| **Inventory** | | |
| manufacturer, model, serial_number, asset_tag | text | |
| purchase_date, warranty_expiry, in_service_date | date | |
| responsible_user_id | FK users null | |
| status | enum planned, active, spare, faulty, retired | Lifecycle, set by people. Never online/offline |
| **Network identity** | | |
| hostname, mgmt_ip, mac, os, firmware | text | Recorded facts, not polled |
| **Origin** | | |
| source | enum manual, integration, csv_import, v1_import | |
| source_integration_id, external_id | null | Lets integration syncs match records on later syncs |
| **Display** | | |
| icon_color, text_color, front_image_id, rear_image_id | | |
| notes | text | |
| created_at, updated_at, created_by, updated_by | | |

**Parent key.** SQL unique indexes treat NULLs as distinct (in SQLite and MariaDB alike), so sibling uniqueness can't be a plain `UNIQUE(room_id, code)`. A generated column fixes this (SQLite syntax shown in section 18; prototyped on MariaDB):

```sql
parent_key VARCHAR(40) AS (CASE
  WHEN parent_device_id IS NOT NULL THEN CONCAT('d:', parent_device_id)
  WHEN rack_id IS NOT NULL THEN CONCAT('k:', rack_id)
  WHEN room_id IS NOT NULL THEN CONCAT('r:', room_id)
  ELSE CONCAT('u:', project_id) END) STORED,
UNIQUE KEY uq_device_code (parent_key, code)
```

The same technique is used anywhere else that needs uniqueness on a nullable parent.

**Racks share the room's code namespace with floor devices.** A rack `RK01` and an access point `RK01` can't both be in one room. This is enforced by giving racks the same `r:<room_id>` parent key in a shared `room_codes` uniqueness table, or by checking in the API's transaction. Recommendation: check in the transaction. It's simpler, and every write goes through the API anyway.

**Rack occupancy rules** are enforced in the API inside the write transaction, not by triggers:
- No two devices overlap on the same U range and face.
- A full-depth (`both`) device blocks both faces.
- A device that has rear ports blocks the rear of its U range.
- Half-width devices can pair side by side.
- Zero-U devices don't use U slots.

### Extension tables (1:1 with devices, only when relevant)

| Table | For | Columns (from today's tables) |
|---|---|---|
| `device_camera` | Cameras | resolution, lens/field-of-view notes. No stream URLs or stream credentials |
| `device_access` | Access-control hardware | door_name, connected_readers (JSON). No lock/open state, access groups or schedules |
| `device_power` | PDUs, UPSes, battery modules, anything with a power supply | input_voltage, input_plug_type, capacity_va, capacity_w, capacity_value, capacity_unit, runtime_curve (JSON), ebm_runtime_curve (JSON), max_ebm_slots, psu_count |

`project_cameras` and `project_access_devices` disappear. Integration syncs upsert `devices` rows plus these extension rows, matched on `(source_integration_id, external_id)`, falling back to MAC address.

### racks
| Column | Type | Notes |
|---|---|---|
| id, room_id | | Racks always sit in a room (DEFAULT at least) |
| code, name | | Shares the room's namespace with floor devices (see above) |
| u_height | int | |
| width | enum 19in, 23in, 10in | |
| depth_mm | int null | Used for "does this device fit?" warnings |
| numbering | enum bottom_up, top_down | |
| rack_type, layout | | Carried over (open frame, enclosed, wall-mount…) |
| plan_x, plan_y, plan_rotation | | Pin on the floor plan |
| responsible_user_id, notes, show_rear, annotation_field, show_annotations | | Display settings carried over |

**Why racks are their own table, not a device:** racks contain things and have their own geometry, but no ports or inventory lifecycle worth sharing. Trays *are* devices (type `tray`), because they mount in a rack like any other device.

---

## 6. Ports, connections and path tracing

This is the core of the redesign.

### ports
| Column | Type | Notes |
|---|---|---|
| id, device_id | | |
| code | | Unique per device across both faces. Uppercase, at most 10 characters |
| face | enum front, rear | Where the port physically sits on the device |
| medium | enum copper, fiber, wireless, power, console, other | |
| connector | text | RJ45, SFP, SFP+, QSFP, LC, SC, ST, E2000, MPO, C13, C14, C19, C20, NEMA 5-15R, NEMA 5-15P, … from a fixed list in code |
| fiber_mode | enum simplex, duplex null | LC, SC, ST and E2000 only |
| **role** | enum active, passive | **active**: a device sends and receives here (switch port, NIC, AP uplink, PSU inlet, PDU outlet). **passive**: a pass-through that joins two cables (patch-panel port, wall outlet, coupler) |
| port_group_id | FK null | The template group it came from (section 7) |
| sort_order | int | Generated numbering order |
| **Network** | | |
| speed, poe, description, mac | | |
| wlan_id | FK wlans null | Wireless ports only: which WLAN it broadcasts or joins |
| **Power** | | |
| outlet_group | int null | PDU and UPS outlets: which group or breaker bank |

### Connections connect port *sides*

A cable plugs into one side of a port:

- An **active** port has one side, `front`.
- A **passive** port has two sides:
  - **`front`** (patch side): where a patch cord plugs in.
  - **`rear`** (permanent side): where the in-wall or backbone cable is punched down or spliced.

A wall outlet's `front` is the jack in the wall, and its `rear` is the cable in the wall. A patch panel port's `front` faces the room, and its `rear` is the cable to the outlet.

```
connections
  id, project_id
  kind          enum permanent, patch, power
  cable_type    text   (Cat6a, OS2, OM4, DAC, C13-C14 …)
  length_m      decimal null
  color         char(7) null     (#rrggbb; one colour for the whole cable)
  label         text null        (what's printed on the cable label)
  notes, created_at/by, updated_at/by

connection_ends
  connection_id  FK connections ON DELETE CASCADE
  end            enum a, b
  port_id        FK ports ON DELETE CASCADE
  side           enum front, rear
  PRIMARY KEY (connection_id, end)
  UNIQUE KEY (port_id, side)        -- one cable per port side, enforced by the database
```

**Rules**, checked in the API on create:

| Rule | Why |
|---|---|
| `permanent` connections join `rear` sides of passive ports only | In-wall cabling runs panel to outlet, or panel to panel (backbone) |
| `patch` connections use `front` sides only | Patch cords plug into jacks and active ports |
| A passive port's `front` can't be patched until its `rear` has a permanent connection | The "no keystone yet" rule. The UI shows such a panel port as an empty frame. **Exception:** couplers and pass-through panels marked `requires_permanent = false` on the template group |
| `power` connections join power ports (an outlet to an inlet) | Replaces today's `power_source_slot_id` / `power_source_outlet` |
| Media must be compatible (copper to copper, fibre to fibre, matching fibre mode), or the cable type is a media converter or DAC | Catches mistakes; the user can override with a warning |
| Connections may cross rooms, floors and locations | Campus fibre is real. Moving a floor or location later cuts these (section 14) |

The old `ports.connected_port_id` becomes one `patch` connection per pair.

### Path tracing (chains)

A **chain** is the sequence of connections reached by walking through passive ports:

```
start at an active port (or any port)
loop:
  follow the cable on the current side to the far port
  if the far port is active, stop: that end is reached
  if it is passive, cross to its other side (front <-> rear) and continue
  if there is no cable, stop: dead end
```

The walk runs in both directions from the chosen port. It is iterative with a visited set, so bad data can't loop forever, and capped at 64 hops.

- **Complete**: both ends of the chain reach active ports.
- **Incomplete**: at least one end stops at a passive port. Example: a switch port patched to a panel, cabled to an outlet, with nothing plugged into the outlet.
- **Unconnected**: no cables at all.

The state belongs to the whole chain. Every port on it shows the same state, using the same colours everywhere: solid blue, dashed or light blue, grey outline.

**Chain colour:** a cable's `color` is per connection. When a user sets a colour on a port that's part of a chain, the UI sets it on the patch connections of that chain. Permanent cabling keeps its own colour. One colour per physical cable matches reality: the patch cord on one side of a panel can differ from the cord on the other side.

**Tracing is computed on demand, not stored.** `GET /api/ports/{id}/trace` returns the ordered hops with full paths. The walk can run as a single recursive SQL query (`WITH RECURSIVE`); a prototype on MariaDB traced switch → panel → outlet → access point correctly and reported complete, then incomplete once the access point was unplugged. It works the same way on SQLite. For the cross-estate Connections table (section 13), a `chain_id` is cached in a `port_chains(port_id, chain_id, state)` table. It is rebuilt for the affected chains inside the same transaction as any connection change, so listing thousands of ports doesn't re-walk every chain.

### Example

```
ACME/HQ/2/MDF/RK01/SW02/13   active   ─patch─▶ front
ACME/HQ/2/MDF/RK01/PP01/03   passive  front → rear
                                       ─permanent─▶ rear
ACME/HQ/2/OFFICE/TO07/01     passive  rear → front
                                       ─patch─▶
ACME/HQ/2/OFFICE/AP01/01     active        ⇒ COMPLETE
```

### VLANs on ports

```
port_vlans
  port_id FK, vlan_id FK project_vlans, mode enum untagged, tagged
  PRIMARY KEY (port_id, vlan_id)
  -- at most one untagged VLAN per port, checked in the API
```

From a rack, the UI can list the VLANs in use there and highlight their ports.

---

## 7. Device library: types and templates

### device_types
`id, project_id, key, label, prefix, placement (floor|rack|either|tray), icon, is_builtin`. Unique `(project_id, key)` and `(project_id, prefix)`. Seeded per project from built-in defaults.

### device_templates
| Column | Notes |
|---|---|
| id, project_id null | NULL project = a built-in template that ships with Rackpath (today's `rackCatalog.js`, about 160 entries). It can't be edited; "Duplicate to customise" copies it into the project |
| device_type_id, manufacturer, model, name | |
| u_height (0 = zero-U), depth, half_width | |
| front_image_id, rear_image_id | Optional photo faceplates. Today's rack image uploads land here |
| power columns | Same shape as `device_power`; copied to devices built from the template |
| version | Increments on every save |

`rack_custom_devices` and `user_catalog_entries` become project templates. User-level catalog entries become project templates owned by the project the user last worked in (decision D2: templates are project-level).

### template_port_groups
A rectangle of ports on a device face, laid out on a grid with **two port rows per U** and a fixed number of columns per face (48 across a 19" face).

| Column | Notes |
|---|---|
| template_id, face | front or rear |
| grid_row, grid_col, rows, cols | Position and size. At most 99 ports per group. No overlaps (checked in the API) |
| prefix | Up to 4 characters. Groups with the same prefix share one numbering sequence (left to right, front then rear) |
| numbering | column_major (1 top, 2 below, the usual switch layout) or row_major |
| medium, connector, fiber_mode, role, requires_permanent | Applied to every port in the group |
| outlet_group | For PDU and UPS outlet banks |

### template_port_overrides
`template_id, port_index, custom_code`. A custom name for one generated port, unique per template, at most 10 characters.

### template_elements
`template_id, face, kind (text|icon), grid_row, grid_col, rows, cols, text, align, highlighted, icon`.

### Creating a device from a template
The API makes the `devices` row, then one `ports` row per generated port, with codes like `P1…P24`, or the custom codes from overrides.

### Editing a template that devices already use
This is where v2 deliberately does better than "rebuild everything and lose all cables":

1. The API diffs the old and new generated ports **by code and face**.
2. Ports that still exist keep their row, their connections and their VLANs. Only changed attributes are updated.
3. Ports that disappear are deleted, which cuts their connections.
4. A **dry run** (`?dry_run=true`) returns, for each affected device:
   - the ports that would be removed;
   - the connections that would be cut, with their full paths;
   - any device that no longer fits its rack because it grew taller.

   The UI shows this, offers a PDF or CSV of it, and requires typing the template name to confirm.
5. Devices that no longer fit are **unmounted to Unplaced**, not deleted.

---

## 8. Power

Power becomes ordinary ports and connections:

- **PDU and UPS outlets** are `active` power ports with connectors such as C13, C19 or NEMA 5-15R, grouped by `outlet_group`.
- **Device power inlets** are power ports named `PSU1` and `PSU2`.
- A power cord is a `power` connection from an outlet to an inlet.
- **UPS to battery module:** a `power` connection between the UPS's battery port and the battery module port. This replaces `ebm_connected_ups_id`.

Today's power maths (outlet counts, load in VA and W, UPS runtime curves, cross-rack power overlay) keeps working. It reads the graph from `connections` instead of the `power_source_*` columns.

`rack_slots.outlet_groups` (JSON) becomes `outlet_group` on the generated outlet ports.

---

## 9. Networks

- **project_vlans**: unchanged, plus `notes`. Assigned to ports through `port_vlans`.
- **wlans** (new): `id, project_id, ssid, description, security (open|wpa2|wpa3|enterprise), hidden, vlan_id FK null, notes`. No passphrase is stored. Wireless ports point to one through `ports.wlan_id`.
- **Logical topology** (`topologies`, `topology_nodes`, `topology_edges`, zones, labels, shapes): kept as the logical or diagram view. It is ported as-is, with two changes:
  - topology nodes reference `devices.id` (unchanged);
  - `topology_edges` may optionally reference `connection_id` or the two `port_id`s, so a diagram link can be "backed by" a real traced cable.
- `topology_node_interfaces` becomes physical `ports`. Logical sub-interfaces (SVIs, VLAN sub-ports) are configuration, not physical documentation, and are not modelled; record them in a device's notes if needed.

---

## 10. Users, roles and permissions

### users
`id, username (unique), email (unique, null), display_name, password_hash (argon2id), must_change_password, totp_secret (encrypted, null), totp_enabled, is_owner, disabled_at, last_login_at, created_at`.

Exactly one owner. The owner can't be deleted or demoted until ownership is transferred.

### role_grants
```
id, user_id, role enum reader, editor, admin,
scope_type enum account, project, location, floor, room, rack, device,
scope_id bigint null   -- NULL only for scope_type = account
UNIQUE (user_id, role, scope_type, scope_id)
```

| Role | Can do |
|---|---|
| **reader** | Read everything in the projects inside its scope. Granted at account or project level only (reading is project-wide by design) |
| **editor** | Reader rights on the containing project, plus create, edit, delete and move within its scope. The scope can be as narrow as one device. Editor on a rack covers its devices, ports and connections |
| **admin** | Editor plus: manage users and grants in its scope, integrations, device library, and project settings. Account-level admins also manage projects, sessions, and system settings |

Rules:
- **Grants cascade downward** (location → floor → room → rack → device). The widest grant wins.
- **A connection can be edited** if the user can edit **either** end's device. This matches how a technician patches their own switch into a shared panel.
- **Integration credentials** are write-only for everyone. Only project admins can create or update them.

**Every endpoint declares the permission it needs.** An Axum extractor resolves the user's effective grants once per request, with the hierarchy walk done in one SQL query using the stored parent IDs. It then rejects the request before the handler runs.

### Sessions (replaces JWT)
```
sessions
  id, user_id,
  token_hash (sha256 of a 256-bit random token),
  created_at, last_seen_at, expires_at, ip, user_agent, mfa_passed
```

- The browser holds the token in an `HttpOnly; SameSite=Strict` cookie (`Secure` when served over HTTPS).
- A session expires after 12 hours idle or 7 days in total.
- Logging out deletes the row. Changing a password deletes every other session. Admins can revoke sessions.

**Why move off JWT:** server-side sessions can be revoked instantly. Rackpath already reads the user on every request, so JWT's "no database hit" benefit is gone.

### Two-factor login
- TOTP (RFC 6238), shown as a QR code at enrolment.
- 10 single-use recovery codes, stored hashed.
- Admins can require 2FA per project or for the whole account.
- Login with 2FA is two steps: password first, then a 6-digit code. The session is created with `mfa_passed = false` until the code is accepted.

### Invitations
```
invitations
  id, email, role grants (JSON), token_hash, invited_by, expires_at (7 days), accepted_at
```

- The admin copies the invitation link and sends it however they like. Rackpath sends no email, so it needs no mail server or SMTP credentials.
- Re-issuing a link invalidates the old one.

### Login protection
The rate limits from v1 carry over: per username and per IP. Failed logins and lockouts are written to the audit log.

---

## 11. Change history (audit log)

```
audit_log
  id bigint, at timestamp(3),
  user_id null (null = system: integration sync)
  project_id null (null = account-level)
  action enum create, update, delete, move, connect, disconnect,
              login, login_failed, logout, grant, revoke, export, import, sync
  resource_type text, resource_id bigint null
  resource_path text           -- full path at the time of the change, so it stays readable after deletes
  changes JSON null            -- {"field": [old, new], …}; secrets appear as "•••"
  request_id char(26)          -- groups the rows of one API call (one move = one entry group)
  ip, user_agent
INDEX (project_id, at), (resource_type, resource_id, at), (user_id, at)
```

- Written **inside the same database transaction** as the change. If the change rolls back, so does its log entry.
- It can't be edited or deleted through the API.
- Retention is configurable (`AUDIT_RETENTION_DAYS`, default: keep forever).
- The UI filters by date range, action, resource type, resource, and user.
- `project_activity_log` and `integration_sync_log` are folded into this table.

---

## 12. Notes, photos and attachments

```
attachments
  id, project_id, resource_type, resource_id,
  kind enum photo, document, floor_plan, faceplate,
  filename (random, stored), original_name, content_type, size_bytes, sha256,
  caption, uploaded_by, uploaded_at
```

Every resource also has a free-text `notes` field. Its change history is in the audit log, so a separate dated journal isn't needed.

- Uploads keep v1's hardening:
  - the file type is checked from the file's own content (magic bytes), not the name;
  - the stored file is renamed at random;
  - files are served with a sandboxing CSP and `nosniff`.
- Limits are configurable (default 10 MB for photos and plans, 2 MB for faceplates).
- File downloads need **read permission on the resource**. v1's unauthenticated image routes go away: images load with the session cookie, same-origin.
- Floor plans are images only: PNG, JPEG or WebP (decision D4). A PDF plan is exported to PNG before uploading.

---

## 13. Cross-site search and tables

**Global search** covers code, name, full path, hostname, IP, MAC, serial number and asset tag. Results are grouped by type, each with its path. It's backed by:
- the `search_path` column, plus a combined `search_text` column on devices, ports, racks, rooms, floors and locations, kept in sync by the API;
- an SQLite **FTS5** full-text index on `search_text`, with prefix matching on `code` and `mgmt_ip`.

**Resource tables** (the "Resources" page) have tabs for Locations, Floors, Rooms, Racks, Devices, Ports and Connections. Every list endpoint shares one query convention:

```
GET /api/projects/{p}/devices?
    filter[manufacturer]=Cisco&filter[warranty_expiry][lt]=2027-06-01
    &filter[serial_number][empty]=true
    &scope=location:12          (limit to one parent)
    &sort=-updated_at,code
    &page[size]=100&page[cursor]=…
    &fields=code,path,model,serial_number
Accept: text/csv                (same query, CSV download of every matching row)
```

- Every column can be filtered and sorted. This is an improvement on Patchdocs, which sorts the devices table on a few fields only.
- CSV exports only the selected columns.
- The Connections tab lists one row per chain, with both ends, every hop and its state.

---

## 14. Moving things

| What | Where to | What comes with it |
|---|---|---|
| Device (floor) | Another room, or Unplaced | Its ports. Its rack contents if it's a tray |
| Rack | Another room | Every device in it |
| Device (rack) | Another rack or U position, a tray, or Unplaced | Its ports |
| Floor | Another location | Its rooms, racks and devices |
| Location | Another project | Everything under it |

`POST /api/moves` with `{resource, target, dry_run}`.

**A dry run reports:**
- **Connections that would be cut.** These are cables between what moves and what stays, *except* moves within the same floor, where the cables are still physically plausible.
- **ID clashes in the target**, with a suggested free code.
- **For cross-project moves:**
  - VLAN and WLAN assignments that need re-mapping. The choice is to reuse an identical network in the target (same number, name and notes) or copy it, or else clear the assignments.
  - Template references that need copying.
  - Responsible users who can't see the target project. These are cleared.

The real move runs in one transaction, writes one audit entry group, and needs edit rights on both the source and the target.

---

## 15. Locations map

**Not included.** A map needs outside tile and geocoding services, which conflicts with keeping all data inside your network. The Locations page shows cards with each site's address and contact, and a location's address can be copied into any mapping app.

---

## 16. Exports

| Export | Contents | How |
|---|---|---|
| **PDF report** of a project, location, floor, room, rack or device | Cover page (resource, project, date, exported by), table of contents, the naming scheme (prefix table), one section per resource with its details and contents, rack elevations front and rear, port and connection lists with full traced paths, VLANs and WLANs used. **Every section has a QR code** linking to `PUBLIC_URL/r/{type}/{id}`, which opens that page in Rackpath | Generated in the API (section 18). Capped at 1,500 devices per report; larger exports are refused with a suggestion to export smaller parts. At most 3 exports per minute per user |
| **Rack bill of materials** | The rack's devices grouped by type and model, with quantity, codes and U positions; patch cords grouped by type, length and colour | PDF and CSV |
| **CSV** | Any resource table (section 13) | Streamed |
| **PNG / SVG** | Rack elevation, floor plan with devices and cables, topology diagram | Rendered in the browser, as today |
| **Pre-change report** | Connections that a template edit or move would cut | PDF and CSV (sections 7 and 14) |

**Short links:** `/r/{type}/{id}` redirects to the right page after login. If the user can't see the resource, they get a 404, not a 403, so the link doesn't reveal that it exists.

---

## 17. What happens to today's tables

There are no production installs, so **v2 starts with a fresh schema** rather than an in-place migration. A one-off `rackpath import-v1 --from mysql://…` command (reading the v1 MariaDB, writing the v2 SQLite file) brings across development or test data on a best-effort basis:

| v1 table | v2 |
|---|---|
| users | users (role: owner and account admin) |
| projects | projects. Site fields (address, ISP, WAN, LAN) move to its first location. A `code` is derived from the name |
| locations | locations; `building_number` goes into `code` if it's valid |
| rooms | floors (one per distinct `rooms.floor` value) + rooms |
| racks | racks. Ones with no room go to the location's floor `0` DEFAULT room, or a "Imported" location when there's no location |
| devices + rack_slots (linked by `device_id`) | devices. A slot linked to an inventory device merges into one device. A slot without a device becomes a device of the matching type |
| rack_slots power columns | device_power + power ports + power connections |
| ports (`connected_port_id`) | ports + `patch` connections (de-duplicated per pair) |
| project_cameras, project_access_devices | devices + device_camera / device_access (inventory columns only) |
| rack_custom_devices, user_catalog_entries | device_templates |
| topology_node_interfaces | ports |
| topology_* (the rest) | unchanged, renumbered |
| project_vlans, device_tags, assignments, integrations | unchanged (integration secrets copied as-is; same key) |
| project_activity_log, integration_sync_log | audit_log |

---

## 18. Rust API architecture

| Concern | Choice | Why |
|---|---|---|
| HTTP | **axum** + tower middleware | Standard, fast, good extractor model for auth and permissions |
| Runtime | tokio | |
| Database | **SQLite** (decision D1) in WAL mode, one file in the data volume, via **sqlx** with compile-time checked queries | No database server, one file to back up, lowest memory use; SQL mistakes become build errors |
| Migrations | `sqlx migrate`, numbered `0001_…` in `api-rs/migrations/` | CLAUDE.md's rules still apply; the folder changes, so CLAUDE.md gets updated when the Rust API lands |
| Serving the UI | The built frontend is embedded in the binary and served by axum | No nginx container: **one container (or one binary) total** |
| Backups | `rackpath backup <file>` uses SQLite's online backup API; uploads are a plain folder | Safe while running; no `mysqldump` |
| Passwords | argon2id (`argon2` crate) | v1's bcrypt hashes are rehashed transparently on the next successful login |
| Secrets at rest | AES-256-GCM (`aes-gcm` crate), **same `v1:` format and `RACKPATH_ENCRYPTION_KEY`** as today | Existing data stays decryptable |
| TOTP | `totp-rs` | |
| PDF | **Typst** (embedded `typst` crate) with templates in the repo | Real layout and table-of-contents support. No headless browser; one binary |
| QR codes | `qrcode` crate → SVG embedded in Typst | |
| Images | `image` crate (validation, thumbnails). No PDF rasteriser (decision D4) | |
| HTTP client | `reqwest` with rustls, used **only** for integrations the user configures | Nothing else makes outbound connections |
| Errors | One `AppError` type → JSON `{error, code}`. 5xx bodies never include internals | Same rule as v1 |
| Observability | `tracing` with JSON logs; a request ID in every log line and audit entry | |
| Config | Environment variables, validated at startup. The process exits with a clear message if a required secret is missing | Same behaviour as v1 now |

**Layout**

```
api-rs/
  src/
    main.rs            config, router, startup checks
    auth/              sessions, password, totp, permissions extractor
    domain/            pure types + rules (naming, rack fit, chain tracing) — no I/O, unit-tested
    db/                sqlx queries per aggregate
    routes/            thin handlers: parse → authorise → call domain/db → audit → respond
    export/            typst templates, BOM, CSV
    integrations/      unifi, protect, access, zabbix, librenms, netbox (inventory import only)
  migrations/
  tests/               API tests against a temporary SQLite file (no services needed)
```

**SQLite specifics.** The model in this document is the same on SQLite; the SQL changes are mechanical:
- ENUM columns become `TEXT` with a `CHECK (col IN (...))`.
- The code rule becomes `CHECK (length(code) BETWEEN 1 AND 16 AND code NOT GLOB '*[^A-Z0-9._-]*')`, with the "starts with a letter or digit" rule checked in the API.
- `parent_key` is a `GENERATED ALWAYS AS (...) STORED` column; `UNIQUE (parent_key, code)` works as on MariaDB.
- JSON columns use SQLite's built-in JSON functions; search uses FTS5; chain tracing uses `WITH RECURSIVE`, which SQLite supports.
- Foreign keys are switched on per connection (`PRAGMA foreign_keys = ON`) and checked at startup.
- Timestamps are stored as UTC ISO-8601 text.

**Deployment** becomes one container with two volumes (`/data` for the database file, `/data/uploads` for files), or the plain binary under systemd. It listens on one port. Required settings: `RACKPATH_ENCRYPTION_KEY`; optional: `COOKIE_SECURE`, `PUBLIC_URL` (for QR links).

**Domain rules live in pure functions** (naming validation, the next free code, rack occupancy, chain tracing, template diffs), so they can be unit-tested without a database. Handlers stay thin.

---

## 19. Decisions

All resolved by the project owner.

| # | Question | Decision |
|---|---|---|
| D1 | Database: MariaDB or SQLite? | **SQLite.** Single binary plus one file: no database container, simple backups, lowest memory use. Plenty for a documentation tool used by a team |
| D2 | Per-user catalog entries, or project-level templates? | **Project-level.** Shared templates are the point of a device library |
| D3 | Reading: project-wide, or narrowable to a location? | **Project-wide.** Narrowing reads would make traced cables disappear into places a user can't see |
| D4 | Floor plans: bundle a PDF rasteriser, or images only? | **Images only** (PNG, JPEG, WebP) in the first release. A PDF page can be exported to PNG with any PDF viewer. Can be revisited later |
| D5 | Frontend build: move from Create React App to Vite? | **Yes, in v2.** No user-facing change; clears the 28 remaining build-tool advisories |
| D6 | Scope | **Documentation only.** No scanning, network tools, polling, live state, stored device credentials, map, or outbound email (section 1) |

---

## 20. Open questions (not blocking)

- **MPO/MTP breakout cassettes:** model as one port for now. Per-strand tracing would need "sub-ports".
- **Rack-to-rack shortcuts:** should a patch cord directly between two racks in the same room (no panel) be a `patch` connection? Yes, as designed; just confirm the UI makes it easy.
- **Cable length warnings:** compute rack-unit distance for patch cords within a rack and warn when `length_m` is too short. Cheap to add once lengths are recorded.
- **Neighbour import (optional):** UniFi and LibreNMS already know which device is on which switch port (LLDP and MAC tables). An integration could *propose* patch connections from that data for a person to accept. Rackpath itself would still never touch the network.

---

## 21. Build order

Each phase ends with something usable and tested. The old Node API keeps serving the frontend until the switch in Phase 6.

1. **Skeleton and security core.** Rust project, config, startup checks, sessions, users, roles, permission extractor, TOTP, audit log, invitations. Tests for every permission rule.
2. **Hierarchy and naming.** Projects, locations, floors, rooms, racks, device types, devices (all placements), unplaced inventory, code generation and validation, global search.
3. **Ports and cabling.** Ports, connections, the side rules, chain tracing, port states, VLAN and WLAN assignment, colours.
4. **Library and power.** Templates and port groups, instantiation, safe template edits with dry run, power ports and connections, the power and runtime calculations.
5. **Port the rest from v1**, behaviour unchanged and checked by contract tests: inventory-only integrations, topology diagrams, VLANs, tags. Add the **CSV importer** for devices, ports and connections, which replaces discovery as the bulk way to bring in a site.
6. **Frontend switch** (Vite, served from the Rust binary): Locations and floor plan editor, rack patching view, template designer, Resources tables, Activity Log, user management, 2FA. Retire the Node API, nginx and MariaDB containers.
7. **Reports and extras.** PDF reports with QR codes, BOM, moves, the v1 importer.
