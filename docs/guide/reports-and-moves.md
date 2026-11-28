# Reports, exports, diagrams and moves

## PDF reports

**PDF report** on a location, floor, room or rack (and on the project
overview) makes a printable document:

- a cover and a contents page with PDF bookmarks;
- each place's details, rack elevations front and rear, and every device
  with its ports, cables and traced paths;
- each location's address plan and the VLANs and Wi-Fi networks in use;
- a **QR code** on every section that opens that page in Rackpath. Stick a
  printed rack report on the rack door and anyone can scan it to see the
  live version.

Set `RACKPATH_PUBLIC_URL` so the QR codes point at the address people use
(see [Install → Settings](installation.md#settings)). Reports are limited to
1,500 devices (export a smaller part if needed) and to three a minute per
person.

## Bill of materials

**Bill of materials** on a rack lists its devices by type and model
(quantity, codes, positions) and its patch and power cords by type, length
and colour, as PDF or CSV. It's handy for ordering, or for checking a build
against the plan.

## CSV exports

**Devices**, **cables**, **prefixes** and **addresses** export as CSV from
their lists. The columns match the [CSV import](integrations.md#csv-import),
so you can export, edit in a spreadsheet, and import.

## Diagrams

**Diagrams** are network drawings: boxes for devices (or free text), and
links between them. A link can be **backed by a documented cable**; it then
shows the cable's ends and whether the chain is complete. Two people editing
the same diagram can't overwrite each other: the second save is refused
until they reload.

## Moving things

**Move** on a device, rack, floor or whole location relocates it, also to
another project. Before anything happens Rackpath **previews** the effects:

- cables that would be cut (to things that aren't moving with it);
- addresses that stay in the old project's IP plan;
- VLAN and Wi-Fi assignments to reuse or copy in the target project;
- codes that clash at the destination (give a new one).

The move is all-or-nothing and appears as one entry in the Activity log. You
need edit rights where the thing is and where it's going.
