# Places, racks and devices

Rackpath models where things are as a tree:

```
Project
└── Location (a building), optionally grouped by Site
    └── Floor
        └── Room (optionally drawn on a floor plan)
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

### Floor plans (optional)

You don't need a floor plan for anything: racks and devices work without
one. A floor opens on its racks; the plan is on the **Floor plan** tab.

1. Open a floor → **Floor plan** tab → **Upload plan** (PNG, JPEG or WebP).
2. Set **Plan scale (pixels per metre)** on the floor so racks are drawn to
   size.
3. Draw **rooms** as outlines on the plan and give each a code (`MDF`,
   `IDF2`, `OFFICE-12`).
4. Drag **racks** and **floor devices** onto the plan; rotate racks to match
   the room.

## Racks side by side

Rooms, floors and one-floor locations show their racks **side by side**,
the way they stand, at one scale and standing on the floor (a 24U rack is
shorter than a 42U one):

- **Rows:** give racks a **Row** (`A`, `B`…) and a **Position in the row**
  (1 is leftmost, seen from the front) when adding or editing them. Each row
  is drawn left to right; racks without a row come last, by code.
- **Front / Rear** switches every rack at once. From the rear a row is seen
  from the other aisle, so its order is mirrored.
- **Click a free U** in any rack to add a device, or place one waiting in
  Unplaced. **Click a device** to open it.
- **Drag a device** from one rack to another.
- **Drag a rack's name** onto another rack to move it there in the row; the
  row is renumbered for you, and dropping onto a rack in another row moves
  it to that row.

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
