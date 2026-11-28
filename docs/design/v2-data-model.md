# Rackpath v2: data model and API design

Status: **approved direction; decisions D1–D5 resolved (section 19)**. Nothing here is built yet.

This document designs the data model for Rackpath v2. That release:

- rebuilds the API in Rust;
- adds physical-layer documentation: buildings, floors, floor plans, cabling and patching, a device template designer, users and roles, a full change history, exports, and cross-site search.

Features and ideas were taken from reviewing Patchdocs. None of its text, design or code is reused, and features tied to its own hardware (patchbox.one cassettes) are left out.

**Rackpath is documentation software.** It records what exists and how it's connected. It does not monitor the network. v1's scanning, network tools, credential macros, SNMP polling and live state were removed (migration 0067). v2 brings back one narrow piece, **opt-in discovery** (section 15a): ping sweeps of small private prefixes and read-only SNMP reads of ARP and MAC address tables, off until an admin turns them on, whose results wait for review instead of becoming documentation.

What stays from v1: inventory-only integrations (UniFi and Zabbix), the logical topology diagram, UPS and power planning, VLANs, tags and self-hosting. New in v2 alongside the physical documentation: **IP address management (IPAM)**, filled automatically from Windows DHCP and DNS (section 9).

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
- **Watching the network:** SSH polling, ping/traceroute tools, up/down status, alerting, port link state, live door or camera state. Rackpath is not a monitoring system. The only traffic it sends to devices is the opt-in discovery of section 15a.
- **Storing device logins** (SSH/HTTP logins, camera stream passwords, Wi-Fi passphrases). A note on a device can point to the entry in your password manager. The only secrets Rackpath stores are the logins and API keys for its own integrations and the read-only SNMP credentials for discovery.
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

Each integration's device kinds (UniFi `usw`/`uap`/`ugw`, Zabbix host groups) map onto these when devices are imported.

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
| hostname, mac, os, firmware | text | Recorded facts, not polled |
| primary_ip_id | FK ip_addresses null | The device's main address (section 9). Replaces v1's free-text `ip` |
| zabbix_host_id | text null | Set by the Zabbix import; the UI shows an **Open in Zabbix** link. No monitoring data is pulled |
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

## 9. Networks and IP addresses

### VLANs, WLANs and the logical topology
- **project_vlans**: unchanged, plus `notes`. Assigned to ports through `port_vlans`. v1's free-text `subnet` becomes a linked prefix (below).
- **wlans** (new): `id, project_id, ssid, description, security (open|wpa2|wpa3|enterprise), hidden, vlan_id FK null, notes`. No passphrase is stored. Wireless ports point to one through `ports.wlan_id`.
- **Logical topology** (`topologies`, `topology_nodes`, `topology_edges`, zones, labels, shapes): kept as the logical or diagram view. It is ported as-is, with two changes:
  - topology nodes reference `devices.id` (unchanged);
  - `topology_edges` may optionally reference `connection_id` or the two `port_id`s, so a diagram link can be "backed by" a real traced cable.
- `topology_node_interfaces` becomes physical `ports`. Logical sub-interfaces (SVIs, VLAN sub-ports) are configuration, not physical documentation, and are not modelled; record them in a device's notes if needed.

### IP address management (IPAM)

IPAM **records the address plan**. Data comes from people, the CSV importer, and the integrations in section 15 (Windows DHCP/DNS, Zabbix, UniFi). The opt-in discovery of section 15a adds "last seen" facts and a review list; it never edits the plan by itself.

#### Storage of addresses
Every address and range bound is stored twice: as canonical text (`10.20.30.5`, `2001:db8::5`) for display, and as a **16-byte binary** for sorting and range queries. IPv4 is stored in its IPv4-mapped IPv6 form (`::ffff:10.20.30.5`), so one comparison works for both families. All maths (containment, next free, overlap) lives in pure Rust functions in `domain/` with unit tests.

#### address_spaces
`id, project_id, name, description`. Every project gets one, `Default`. A second space is only needed when the same private range really exists twice in one project (separate routing domains). Unique `(project_id, name)`.

#### prefixes (subnets)
| Column | Notes |
|---|---|
| id, project_id, space_id | |
| cidr | Canonical, e.g. `10.20.30.0/24`. Host bits must be zero. Unique `(space_id, cidr)` |
| family, prefix_len, net_start, net_end | Derived from `cidr` on save |
| vlan_id | FK project_vlans null. A VLAN's page lists its prefixes |
| location_id | FK locations null |
| role | users, servers, management, voice, printers, iot, guest, transit, wan, loopback, other |
| status | planned, active, deprecated |
| gateway | text null: the default gateway, from DHCP option 3 or typed in |
| dns_servers, domain_name | text null: from DHCP options 6 and 15, or typed in |
| description, notes | |
| source, source_integration_id, external_id, missing_from_source_at | Ownership fields (section 15) |

**Nesting is computed, not stored.** CIDR blocks either nest or don't overlap at all, so a prefix's parent is simply the smallest prefix in the same space that contains it. The UI shows them as a tree.

v1's location WAN/LAN fields become prefixes with role `wan` or `users` on that location; ISP name, circuit ID and contact stay on the location.

#### ip_ranges
`id, prefix_id, start_text, end_text, start_bin, end_bin, kind (dhcp_pool | reserved | static), description` + ownership fields. A range must sit inside its prefix and must not overlap another range in it.

#### ip_addresses
| Column | Notes |
|---|---|
| id, project_id, space_id | |
| address, family, addr_bin | Unique `(space_id, address)` |
| prefix_len | The mask configured on the interface (usually the prefix's) |
| device_id, port_id | Both null for a documented-but-unassigned address. A port implies its device |
| role | primary, secondary, gateway, vip (shared by a redundant pair; recorded once), loopback |
| status | reserved, assigned, deprecated |
| mac | text null. A **DHCP reservation's MAC** is how imports link an address to a device automatically |
| dns_name, dns_aliases (JSON) | From DNS imports or typed in |
| dhcp_reservation | bool: true when Windows DHCP holds a reservation for it |
| description, notes | |
| source, source_integration_id, external_id, missing_from_source_at | Ownership fields (section 15) |

The prefix an address belongs to is computed (smallest containing prefix in its space). An address outside every prefix is allowed but raises a warning.

#### dhcp_lease_snapshots (optional, per integration)
`id, integration_id, scope_external_id, address, mac, hostname, expires_at, state, captured_at`. **Replaced wholesale on every import.** Leases are not documentation and are never turned into `ip_addresses` automatically. They're shown in the address grid as a separate layer ("lease, seen 26 Nov 14:00") so you can see pool usage. One click on a lease promotes it to a documented address. Off by default.

#### What IPAM shows and checks
- **Prefix tree** per space, each with a usage bar: documented addresses, DHCP pool size and, when snapshots are on, leases in use.
- **Address grid** for any IPv4 prefix up to /22: one cell per address, coloured by state (gateway, assigned, reserved, DHCP pool, reserved range, lease snapshot, free). IPv6 prefixes show a list instead.
- **Next free address**: the first address not documented, not in a DHCP pool or reserved range, not the network or broadcast address, and not the gateway. Offered when adding an address or a device.
- **Warnings** on the dashboard and the prefix page:
  - an address outside every documented prefix;
  - the same MAC on two reservations;
  - a manually documented static address inside a DHCP pool (Windows reservations are expected inside the pool range and don't count);
  - a port's address in a prefix whose VLAN isn't on that port;
  - a prefix with no VLAN (for user, server, voice, printer and IoT roles);
  - an imported record marked "missing from source".
- **Search** finds any address or prefix and shows the device, port and full path, e.g. `10.20.30.2 → HQ/2/MDF/RK01/SW02/24`.
- **Resources tables** get Prefixes, Ranges and Addresses tabs with filters and CSV export; PDF reports include each location's address plan.

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

**Global search** covers code, name, full path, hostname, IP addresses and prefixes, DNS names, MAC, serial number and asset tag. Results are grouped by type, each with its path. It's backed by:
- the `search_path` column, plus a combined `search_text` column on devices, ports, racks, rooms, floors and locations, kept in sync by the API;
- an SQLite **FTS5** full-text index on `search_text`, with prefix matching on `code`, addresses and prefixes.

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

## 15. Integrations and imports

Integrations follow one rule: **Rackpath reads from systems that already hold the facts.** (Discovery, section 15a, is the one opt-in exception that contacts devices.) Connections between ports are always entered by hand (decision D7). There is no locations map: it would need outside tile and geocoding services.

| Source | Direction | What it brings in |
|---|---|---|
| **Windows DHCP and DNS** (Active Directory) | **Pushed to Rackpath** by a PowerShell script, or an uploaded export file | Prefixes, DHCP pools, exclusions, reservations, static DNS names, optional lease snapshot |
| **Zabbix** (the network monitor) | Rackpath pulls through the Zabbix API, read-only API token | Devices (hosts), their interface IPs, inventory fields (model, serial), and the Zabbix host ID for an "Open in Zabbix" link. **No monitoring data** (problems, availability, graphs) |
| **UniFi Network / Protect / Access** | Rackpath pulls through the UniFi API | Devices, management IPs, and configured networks (VLAN ID and subnet). Where UniFi runs DHCP (a home or small site), its DHCP range, DNS servers and fixed-IP clients (as reservations) too, plus an optional lease layer; switch this off per integration where Windows runs DHCP |
| **CSV** | Uploaded | Locations, racks, devices, ports, connections, prefixes, ranges and addresses, using the same column names as the CSV exports |

### Windows DHCP and DNS

**Push, not pull.** Windows DHCP has no web API, and logging in to it from Rackpath would mean storing a domain credential. Instead a small script on the Windows side sends the data:

1. An admin creates a **Windows DHCP/DNS** integration in Rackpath and chooses the project and address space. Rackpath generates an **import token**, shows it once, and stores only its hash. The token can only call this integration's import endpoint and can be revoked or rotated at any time.
2. The repo ships `tools/windows/Push-RackpathDhcp.ps1` (plain PowerShell, readable before use) and `Register-RackpathTask.ps1`, which installs it as a **scheduled task** (default: hourly). Recommended: run it as a **group managed service account (gMSA)**, so there's no password to manage. The token is stored on the Windows side encrypted with DPAPI, so only that account can read it.
3. The script runs on a domain controller or the DHCP server and needs **read-only** rights:
   - **DHCP:** membership of the built-in **DHCP Users** group;
   - **DNS:** read access to the zones it exports (confirmed during build; see section 20).
4. It collects, using Microsoft's own `DhcpServer` and `DnsServer` modules:
   - scopes (`Get-DhcpServerv4Scope`, `Get-DhcpServerv6Scope`) with options 3, 6 and 15;
   - exclusion ranges and reservations;
   - DNS A, AAAA and PTR records from the zones you list, **static records only**. Windows timestamps the records that DHCP clients register dynamically, and the script skips those, so laptops and phones never flood the documentation;
   - leases, only if the integration has "lease snapshot" switched on.
5. It sends one JSON document over **HTTPS** (it refuses plain HTTP unless told otherwise) to `POST /api/imports/windows-dhcp` with `Authorization: Bearer <token>`. The body is gzip-compressed, limited to 20 MB, at most one import per minute per token.

**Alternative with nothing installed:** run `Export-DhcpServer -File dhcp.xml` and upload the file on the IPAM page. It covers DHCP only (no DNS) and is handy for a first load or a one-off site.

**What lands where**

| Windows | Rackpath |
|---|---|
| Scope (`10.20.30.0`, mask `255.255.255.0`, name, description) | Prefix `10.20.30.0/24`; name goes to description; gateway, DNS servers and domain from options 3, 6, 15 |
| Scope start–end range | `dhcp_pool` range |
| Exclusion range | `reserved` range |
| Reservation (IP, MAC, name, description) | Address with `dhcp_reservation = true`, status reserved. **Linked to a device automatically** when exactly one device has that MAC |
| Static DNS A/AAAA record | Address with `dns_name`, or the name added to an existing address. A second name for the same address goes to `dns_aliases` |
| Static PTR record | Fills `dns_name` if empty; a PTR that disagrees with the A record raises a warning |
| Lease (optional) | `dhcp_lease_snapshots` row, replaced on every import |

### Ownership rules (all imports)
- Every imported record carries `source`, `source_integration_id` and an `external_id` (for Windows: server name plus scope ID, reservation IP and so on), so later imports update the same record instead of creating duplicates.
- **An import owns only the facts it brought in** (for an address: MAC, DNS name, reservation flag, description from Windows). **People own everything else** (notes, the device and port it's linked to, location, role). A sync never overwrites people's fields.
- **When a record disappears at the source**, Rackpath sets `missing_from_source_at` and shows a warning. By default it is never deleted automatically. An admin can turn on `remove_missing` for an integration; syncs then delete the records it owns that are gone, except devices with documented cables or devices on them (kept and flagged). Deletions count toward the hold threshold and are listed in the sync's audit entry.
- An import is processed in one transaction and writes one grouped `sync` entry in the audit log, with counts and the changed records.
- An import that would change more than a set share of a source's records at once (default 50%) is held for an admin to approve, so a broken script or wrong token can't wipe the documentation.

---

## 15a. Discovery (opt-in)

An IPAM that only knows what someone typed in misses the static addresses nobody wrote down. Enterprise IPAMs fill the gap two ways, and Rackpath does both, narrowly:

- **Ping sweeps** of a prefix: one ICMP echo per usable address, 32 in flight, 1 s timeout, then reverse DNS for hosts that answer. Only private IPv4 prefixes of /22 or smaller; never IPv6 (a /64 can't be swept). Pings use unprivileged ICMP sockets, so the container needs no capabilities.
- **SNMP reads** of routers (ARP: IP → MAC) and switches (bridge forwarding tables: MAC → port). Read-only GET/GETBULK; SNMPv3 authPriv by default, v2c with a warning. Only private IP addresses. Credentials encrypted, write-only.

Rules:
- **Off by default**, per prefix and per SNMP device; admins only. By hand ("Scan now") or on a schedule of hourly to weekly. One run at a time server-wide.
- **Review, never auto-document.** Unknown live addresses go to `discovered_hosts` (new or ignored). Documenting one creates the address; ignoring hides it for good. Documented addresses only get `last_seen_at`, `last_seen_mac` and `last_seen_port`.
- **Warnings:** a different MAC at a documented address; a documented address in a scanned prefix silent for 30 days.
- **Usage and free lists** count live discovered hosts as used.
- **Audited:** one `sync` entry per run, written with its results; settings, SNMP devices and review actions are audited as usual.

Tables (migration 0012): `prefixes.scan_enabled`, `scan_interval_minutes`, `last_scan_at`; `ip_addresses.last_seen_*`; `snmp_sources`; `discovery_runs`; `discovered_hosts`.

## 16. Exports

| Export | Contents | How |
|---|---|---|
| **PDF report** of a project, location, floor, room, rack or device | Cover page (resource, project, date, exported by), table of contents, the naming scheme (prefix table), one section per resource with its details and contents, rack elevations front and rear, port and connection lists with full traced paths, the location's address plan (prefixes, ranges, documented addresses), VLANs and WLANs used. **Every section has a QR code** linking to `PUBLIC_URL/r/{type}/{id}`, which opens that page in Rackpath | Generated in the API (section 18). Capped at 1,500 devices per report; larger exports are refused with a suggestion to export smaller parts. At most 3 exports per minute per user |
| **Rack bill of materials** | The rack's devices grouped by type and model, with quantity, codes and U positions; patch cords grouped by type, length and colour | PDF and CSV |
| **CSV** | Any resource table (section 13) | Streamed |
| **PNG / SVG** | Rack elevation, floor plan with devices and cables, topology diagram | Rendered in the browser, as today |
| **Pre-change report** | Connections that a template edit or move would cut | PDF and CSV (sections 7 and 14) |

**Short links:** `/r/{type}/{id}` redirects to the right page after login. If the user can't see the resource, they get a 404, not a 403, so the link doesn't reveal that it exists.

---

## 17. What happens to today's tables

There are no production installs, so **v2 starts with a fresh schema** rather than an in-place migration, and there is no upgrade path from v1. A one-off `rackpath import-v1 --from mysql://…` command (reading the v1 MariaDB, writing the v2 SQLite file) brings across development or test data on a best-effort basis:

| v1 table | v2 |
|---|---|
| users | users (role: owner and account admin) |
| projects | projects. Site fields (address, ISP) move to its first location; WAN and LAN fields become prefixes and addresses on it. A `code` is derived from the name |
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
| project_vlans | VLANs; the free-text `subnet` becomes a prefix linked to the VLAN |
| devices.ip, topology interface IPs | ip_addresses linked to the device (and port, where known) |
| device_tags, assignments, integrations (UniFi, Zabbix) | unchanged (integration secrets copied as-is; same key) |
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
| HTTP client | `reqwest` with rustls, used **only** for the UniFi and Zabbix integrations the user configures | Nothing else makes outbound connections. Windows data arrives inbound on the token-protected import endpoint |
| Import tokens | 256-bit random, shown once, stored as a SHA-256 hash, scoped to one integration's import endpoint | Same pattern as sessions; revocable |
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
    integrations/      unifi, protect, access, zabbix (pull); windows_dhcp (push endpoint + XML upload); csv
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
| D6 | Scope | **Documentation first.** No network tools, monitoring, live state, stored device logins, map, or outbound email (section 1). Opt-in, review-only discovery (ping sweeps, read-only SNMP) is the one exception (section 15a) |
| D7 | How do connections get in? | **By hand, as in Patchdocs:** drag port to port in the rack view, pick the far end in a dialog, or the CSV importer for bulk loads. No connection data is imported from integrations, and no neighbour-table suggestions |
| D8 | Integrations | **UniFi (Network, Protect, Access) and Zabbix**, inventory only. NetBox and LibreNMS removed (NetBox holds one site, not worth importing). **Windows DHCP/DNS** added for IPAM |
| D9 | How does Windows data get in? | **Pushed by a read-only PowerShell scheduled task** with a revocable import token, or an uploaded `Export-DhcpServer` file. Rackpath stores no Windows credentials. DNS: static records only. Leases: optional snapshot, never documentation |

---

### Phase 1 notes (as built)

- **Queries** use sqlx's runtime API, not the `query!` macros: sqlx 0.9 only accepts compile-time literal SQL strings (dynamic filters go through `QueryBuilder`), which gives the injection protection without needing a database at build time. End-to-end tests cover every query.
- **First start** creates the owner `admin` with a random 20-character temporary password printed once to the console (not a fixed default). `rackpath reset-password <user>` recovers access.
- **Requiring 2FA** is account-wide for now; per-project requirement is deferred until projects carry real data.
- **Two-factor codes** have replay protection (a code's time step can only be used once) and their own rate limit.
- **Invitations** re-check the inviter's rights at acceptance, so a link from someone who has since lost admin rights stops working.
- **The audit log** is append-only at the database level (an update trigger), and keeps the username after a user is deleted.
- **Measured** (release build): 6.1 MB binary, about 8 MB of memory idle.

### Phase 2 notes (as built)

- **Rack positions** are stored in half-U steps (`rack_pos_half`, `u_height_half`), so there are no floating-point positions in the database. The API speaks in U (`"u": 10.5`, `"u_height": 2`).
- **Trays** are devices of the built-in `tray` type. Only floor and either types sit on them, and a tray can't sit on a tray. A tray holding devices can't be unplaced; deleting it needs a choice for its devices.
- **Paths** come from one SQL view (`v_entities`) and are cached in `search_entries`, which each write refreshes inside its own transaction (a whole subtree when a code changes). An FTS5 index mirrors it through triggers. With 1,000 devices, renaming a location re-indexes in about 12 ms, and a search takes about 2 ms.
- **Deleting a container that holds devices** requires `devices: "unplace" | "delete"` plus the container's code. Unplaced devices are renamed (`SW01-2`) if their code is taken in the Unplaced list, and each move is recorded in the change history.
- **Readers** can only be granted at project or account level (400 otherwise), matching D3.
- **Password hashing** moved to a bounded blocking pool (two at a time). Memory measured on a release build: 9 MB idle, about 28 MB after the first sign-in (argon2's working memory, reused afterwards, not growing), about 45 MB after creating 1,000 devices. Binary: 7.0 MB.
- **Built-in device types** (29) are seeded for each project on creation and at every start, so later releases can add more.

### Phase 3 notes (as built)

- **Three separate things:** the port's `connector` (jack or cage: RJ45, LC, SFP, SFP+, SFP28, QSFP+, QSFP28…), the `transceiver` in a cage (10GBASE-SR, 10GBASE-LR, 10GBASE-T…), and the connection's `cable_type` (Cat5e, Cat6, Cat6a, OS2, OM4, DAC SFP+…). The catalogs live in code (`src/domain/media.rs`), so adding one needs no migration. `medium` is derived from them and stored for filtering.
- **Compatibility** is two-level: physically impossible combinations are refused (RJ45 to LC, QSFP DAC in an SFP+ cage, DAC into a port holding an optic); plausible mistakes are accepted with warnings (single-mode cable on a multimode optic, SR facing LR, Cat5e at 10G, Cat6 at 10G beyond 55 m, multimode runs beyond the optic's reach). Changing a port's connector or transceiver is refused (409) if it would no longer fit a cable already plugged in.
- **Connection ends** are a table with `UNIQUE (port_id, side)`; a trigger deletes a connection as soon as it loses an end, so deleting a port or device never leaves half a cable.
- **Chain state is computed on demand**, not cached: the `port_chains` table from section 6 isn't needed yet. Listings load only the chains touching the listed ports, batch by batch. Measured on a release build: a rack with 1,920 ports and 1,920 cables lists in about 35 ms (1.4 MB of JSON), a trace takes about 2 ms, adding a cable about 3 ms.
- **Listings are built by SQLite as one JSON value** (`json_group_array`) and serialized from typed structs: decoding thousands of rows one at a time through sqlx was the bottleneck (about 28 µs per row). Memory after listing that rack: about 31 MB; after 20 simultaneous listings, about 70 MB.
- **Moves and cables:** the section 14 rule is applied to plain device and rack moves already: within a floor, cables stay; leaving the floor removes cables to anything not moving along. Unplacing removes all of a device's cables, and unplaced devices can't be cabled. Removed cables are listed in the change history.
- **Power cables** (`kind: power`) are in the schema but refused until phase 5.
- **Ports in search:** `v_entities` gained port rows (path = device path + port code). They're excluded from search unless `kind=port`, so a switch's 48 ports don't crowd out the switch.
- **WLAN requests** reject unknown fields, so a passphrase can't be stored by accident.
- **MPO breakout** stays one port, as in section 20.

### Phase 4 notes (as built)

- **Binary form:** a 16-byte big-endian BLOB, IPv4 in mapped form. SQLite compares BLOBs bytewise, so `BETWEEN net_start AND net_end` works directly with an index; every query also matches the family, since `::/0` numerically covers the mapped IPv4 block. The maths (parsing, canonical text, containment, usable range, next free) is in `src/domain/ip.rs` with unit tests, including the top of the IPv6 space.
- **Permissions** (D3 applied to IPAM): prefixes with a location need edit rights there, otherwise on the project; ranges follow their prefix; an address on a device needs edit rights on that device, otherwise on the project.
- **Next free with `prefix_id`** picks the address in the same transaction as the insert, and the unique index on `(space_id, addr_bin)` makes a simultaneous second claim fail with 409 instead of creating a duplicate.
- **No CHECK ties `port_id` to `device_id`** on addresses: when a device is deleted, SQLite applies the two `SET NULL` actions one at a time, and the CHECK would fail half-way. The API keeps them consistent.
- **Search:** prefixes and addresses are in the search index with their own text (CIDR, DNS names and aliases, MAC, description). Where an address is plugged in is looked up live at search time (`detail`), so renaming a device or project never leaves stale results. A project code change re-indexes everything except IPAM entries, which don't contain it.
- **Not yet:** `source_integration_id` and DHCP lease snapshots arrive with integrations in phase 6 (adding a column with a foreign key later is a plain `ALTER TABLE`).
- **Measured (phase 4)** (release build, a /16 with 5,000 addresses and 202 prefixes): next-free allocation about 4 ms, prefix tree 9 ms, prefix page 45 ms (it shows the first 1,000 addresses; the address list pages through the rest), warnings 5 ms, search 2 ms, memory 58 MB.



### Phase 5 notes (as built)

- **Templates reference the device type by key**, not id, so built-ins (project NULL) work in every project. A custom type can't be deleted while a template uses it.
- **Built-ins** are defined in code and seeded once each by key at start. Changing a built-in in a later release never touches existing devices; new built-ins simply appear. There are 15 generic ones (v1's catalogue was generic types, not vendor models).
- **Ports remember whether a template made them** (`from_template`). Only those take part in template updates, so ports added by hand are never deleted by a template change; template ports can't be renamed on the device (rename them in the template).
- **Template updates run in one transaction, and the dry run is the same code rolled back**, so the preview can't drift from what applying does. Destructive changes need `confirm_name`. Template-controlled port attributes are face, role, connector, medium, fibre mode, outlet group and order; transceiver, speed, PoE and description are starting values only, so per-port choices (which optic is fitted) survive edits. Manufacturer, model and power figures follow the template only where the device still has the template's old value.
- **Power is computed on demand** from the cord graph (no stored power tree): demand flows upstream, split evenly across a device's connected inlets; the failover figure assumes every other feed of its loads has failed (the "B side down" case). The maths is pure (`src/domain/power.rs`) with unit tests, and is loop-safe.
- **Runtime** uses v1's linear interpolation of the UPS curve, plus each connected battery module's added-runtime curve at the same load. A UPS is recognised by having a runtime curve; battery links are `power` connections between `Battery` ports.
- **No images yet:** template faceplate photos arrive with attachments.
- **Measured** (release build): 200 devices made from a 50-port template in 5.8 s (about 29 ms each); adding 4 ports to that template updates all 200 devices (800 new ports) in about 1.1 s, and the dry run takes the same; memory 35 MB.

### Phase 6 notes (as built)

- **One import engine.** Every source produces the same snapshot (devices, networks, reservations, DNS records, leases), and one function applies it with the ownership rules. Adapters are thin: they fetch and map, and their mapping is unit-tested against real response shapes. The HTTP side is contract-tested against mock UniFi and Zabbix servers.
- **Dry run and hold reuse the transaction:** the import runs, is measured, and is rolled back when it's a dry run or must be held. A held import stores its snapshot and is applied as received on approval. A newer import supersedes a held one.
- **External ids don't include the Windows server name**, so DHCP failover partners pushing the same scopes don't create duplicates (section 20's open question). Addresses use one id per IP (`addr:<ip>`), so a reservation, a DNS name and a device IP for the same address meet on one record.
- **Windows exclusions sit inside the scope range**, but Rackpath ranges never overlap, so the DHCP pool is stored split around the exclusions. When the source moves a range, the old overlapping range it owned is replaced rather than left as a duplicate.
- **XML uploads never mark addresses missing**, since an export file has no DNS.
- **The DPAPI token is machine-scoped and locked down by its access list**, not user-scoped as first designed: the installer can't encrypt as a gMSA. The effect is the same (only that account and admins can read it).
- **The XML reader** accepts only the predefined entities and refuses DTDs, so entity expansion attacks don't apply; it's also bounded in size and depth.
- **UniFi DHCP** is folded in, as decided for home use: per integration, `import_dhcp` (default on) and `lease_snapshot` (default off).
- **Not yet:** device extension tables for camera and access-control details (cameras and readers import as plain devices); the PowerShell scripts haven't been run on Windows from this build environment and need a first check on a real DHCP server.
- **Topology diagrams** are stored as nodes, edges and items saved together; v1's uploaded diagram icons arrive with attachments.
- **Measured:** the release binary grew to 12.5 MB with the HTTPS client (rustls) for UniFi and Zabbix; about 13 MB of memory at idle.

### Phase 7 notes (as built)
- **The web app** is React + TypeScript built with Vite (`web/`), served by the Rust binary with a strict same-origin CSP. No component framework: a small kit of its own, v1's design tokens and fonts.
- **Diagrams** are drawn with plain SVG rather than AntV X6, which kept the app's dependencies to React, React Router, lucide icons and a QR encoder.
- **Floor plans** are images only (decision D4); rooms are drawn as polygons on them, racks and floor-standing devices are positioned in plan pixels, and racks are drawn to size from the floor's scale.
- **Browser tests** (Playwright) drive the real release binary through every page; CI runs them.
- **Retired:** `api/`, `frontend/`, `db/` and the MariaDB container. `docker-compose.yml` runs one container with one volume.

### Phase 8 notes (as built)
- **PDF reports** are drawn with krilla (the PDF writer underneath Typst) and a small layout engine in `src/export/pdf.rs`, with embedded DejaVu fonts. Typst itself was tried first, but its bibliography support brings in a quick-xml with open security advisories (2026-0194/0195), so it would have failed `cargo audit`.
- **Moves** reuse the device and rack update logic inside one transaction; a dry run performs the whole move and rolls it back, so the preview is exact.
- **The v1 importer** drives the v2 API in-process as a temporary account, so imported data passes every v2 rule. It is tested against a real MariaDB with v1's schema (kept as a test fixture).
- **Which v1 it reads.** The last published v1 images stop at v1 migration 0064; 0065 to 0068 (v1's own clean-up before it was retired) were never released, and only widen or drop columns the importer doesn't read. So it accepts a v1 database from 0064 on. Integration secrets from 0065 on are already in v2's AES-256-GCM format and key and are kept as they are; older ones are MariaDB `AES_ENCRYPT` keyed by v1's JWT secret, so the importer decrypts them with `RACKPATH_V1_JWT_SECRET` and encrypts them again. A secret it can't read is left out and listed, never stored unreadable.

---

## 20. Open questions (not blocking)

- **MPO/MTP breakout cassettes:** model as one port for now. Per-strand tracing would need "sub-ports".
- **Rack-to-rack shortcuts:** should a patch cord directly between two racks in the same room (no panel) be a `patch` connection? Yes, as designed; just confirm the UI makes it easy.
- **DNS read rights for the Windows script:** confirm the minimum rights `Get-DnsServerResourceRecord` needs on your domain controllers, and document them in the script's README.
- **DHCP failover pairs:** if two Windows servers share scopes in a failover relationship, the script should run against one partner only, or Rackpath should de-duplicate by scope ID. Decide when building.
- **Cable length warnings:** compute rack-unit distance for patch cords within a rack and warn when `length_m` is too short. Cheap to add once lengths are recorded.

---

## 21. Build order

Each phase ends with something usable and tested. **All eight phases are built** (notes below); the Node API, nginx and MariaDB were retired in phase 7.

1. **Skeleton and security core.** Rust project, config, startup checks, sessions, users, roles, permission extractor, TOTP, audit log, invitations. Tests for every permission rule.
2. **Hierarchy and naming.** Projects, locations, floors, rooms, racks, device types, devices (all placements), unplaced inventory, code generation and validation, global search.
3. **Ports and cabling.** Ports, connections, the side rules, chain tracing, port states, VLAN and WLAN assignment, colours.
4. **IPAM.** Address spaces, prefixes, ranges, addresses, next-free and warnings; addresses attached to ports and devices.
5. **Library and power.** Templates and port groups, instantiation, safe template edits with dry run, power ports and connections, the power and runtime calculations.
6. **Integrations and imports.** Port UniFi and Zabbix (inventory only, plus their IPs into IPAM) and the topology diagrams, VLANs and tags, checked by contract tests. Add the **Windows DHCP/DNS import** (endpoint, tokens, PowerShell script and scheduled-task installer, XML upload) and the **CSV importer**, with the ownership rules and the held-import safeguard.
7. **Frontend switch** (Vite, served from the Rust binary): Locations and floor plan editor, rack patching view, template designer, Resources tables, Activity Log, user management, 2FA. Retire the Node API, nginx and MariaDB containers.
8. **Reports and extras.** PDF reports with QR codes, BOM, moves, the v1 importer.
