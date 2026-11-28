# Places, racks and devices

Rackpath models where things are as a tree:

```
Project
└── Location (a building), optionally grouped by Site
    └── Floor
        └── Room (drawn on the floor plan)
            ├── Rack ─ devices at U positions, trays, zero-U side mounts
            └── Floor-standing devices (access points, wall outlets, printers…)
```

## The quick way

A new project's **Overview** shows three **Get started** steps: add a
location, add a rack, put devices in it. Each has its button, and the card
disappears once they're done.

- **Add rack** is on the Overview, the Locations page and each location. Its
  **Where** picker lists every place a rack can go ("HOUSE", or
  "HQ / floor 2 / MDF" once you have floors and rooms). With no location yet,
  it asks you to add one first.
- A location with **one floor and no rooms drawn** shows its racks and
  devices right on the location page; you never need to open the floor or
  room. Floors and rooms come into play when you add a second floor or draw
  rooms on a floor plan.
- Devices waiting in **Unplaced** (for example from UniFi) are listed on
  the Overview. Open a rack and click a free U, then choose **A device from
  Unplaced**, or use **Place a device**. In a room, or on a one-floor
  location, use **Place from Unplaced** for access points, desktops and other
  things that don't go in a rack.

## Locations and sites

A **location** is a building. Open **Locations** → **Add location** and give
it a code (`HQ`) and, optionally, an address, a site contact and its internet
circuits (ISP, circuit ID, support contact). Phone numbers are formatted as
you leave the field.

Several buildings on one campus? Give each the same **Site** (`Main campus`).
The Locations page groups buildings by site, and reports show the site too.

## Floors and rooms

A new location gets floor `0`, and every floor gets a `DEFAULT` room, so you
can place devices before drawing anything. Add more floors from the
location's page (code, name, level: 0 is ground, negative is below).

### Floor plans

1. Open a floor → **Upload plan** (PNG, JPEG or WebP).
2. Set **Plan scale (pixels per metre)** on the floor so racks are drawn to
   size.
3. Draw **rooms** as outlines on the plan and give each a code (`MDF`,
   `IDF2`, `OFFICE-12`).
4. Drag **racks** and **floor devices** onto the plan; rotate racks to match
   the room.

## Racks

**Add rack** (height in U, default 42; the code is suggested). The rack page
shows the **front and rear elevations**:

- **Click a free U** to add a new device there, or to place one waiting in
  Unplaced; **drag** a device to move it.
- Positions go in **half-U** steps. A device can be full depth or front/rear
  only, full width or a left/right half.
- **Zero-U** devices (vertical PDUs, cable managers) mount on the sides.
- **Trays** (shelves) hold devices that don't mount on rails.
- The **patching view** lists every port in the rack with both cables, its
  VLANs and where the chain ends (see [Cabling](cabling.md)).
- The **power** tab sums the load per feed (see
  [Templates and power](templates-and-power.md)).

## Devices

Add devices from a rack, a room, or **Devices** → **Add device**:

- **Device type** (switch, router, server, patch panel, access point,
  wall outlet, …) decides where it can go: a switch goes in a rack, an access
  point on a floor.
- **Template** (optional) brings the model's ports, power and size; see
  [Templates](templates-and-power.md).
- **Code** is suggested from the type; **name**, hostname, MAC, serial
  number, asset tag, firmware, purchase and warranty dates, the responsible
  person and notes are yours to fill in.
- **Tags** (set up in project settings) group devices across places.

Devices with nowhere to go yet (for example, ones an integration brought in)
wait in the project's **Unplaced** list. Put them in place from the rack
(**Place a device**, or click a free U) or the room (**Place from
Unplaced**), or edit one and choose its place.

## Deleting

Deleting a room, rack or tray that still holds devices asks what to do with
them: **move them to Unplaced** (their cables are removed) or **delete them
too**. You type the code to confirm. Deleting a device keeps its IP
addresses, unlinked.
