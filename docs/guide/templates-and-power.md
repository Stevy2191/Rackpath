# Templates and power

## Device templates

A **template** describes a model once: its type, height, manufacturer,
model, power figures and **port layout**. Devices made from it get all of
that, and stay linked to it.

Open **Templates** in the sidebar.

### Built-in templates

Rackpath ships with common ones: 24/48-port switches, 24/48-port patch
panels, a 24-port fibre panel, 1U/2U servers, a firewall, 1500 VA and
3000 VA UPSes, a battery module, horizontal and vertical PDUs, a wall outlet
and an access point. Built-ins can't be edited: **Duplicate** one into your
project and change the copy.

### Designing a template

The designer shows the device's front and rear faces as a grid (two port
rows per U, 48 columns). Draw **port groups** as rectangles:

1. Drag a rectangle on the face.
2. Set the group's **prefix** (up to 4 characters, e.g. `G` for `G1`…), the
   numbering order (*column major*: 1 above 2, the usual switch layout; or
   *row major*) and the port settings: connector, speed, PoE, outlet bank…
3. The preview names every port as you go. Groups with the same prefix share
   one sequence, left to right, front before rear.
4. Rename single ports if the model has odd names.

Overlapping groups, groups off the face, more than 99 ports in a group and
duplicate names are refused, and shown in red before you save.

### Editing a template that's in use

Saving a template updates **every device made from it**. Before it saves,
Rackpath shows exactly what will happen to each device:

- ports that stay keep their cables, VLANs and addresses;
- ports that disappear are deleted, with their cables;
- a device that no longer fits its rack moves to Unplaced.

If anything would be removed, you type the template's name to confirm. Ports
added to a device by hand are never touched.

## Power

### Power ports and cords

Power outlets and inlets are ports with a power connector (C13/C14,
C19/C20, NEMA, Schuko, BS 1363, battery, DC). Templates for PDUs and UPSes
already have them.

A **power cord** is a cable from an outlet to an inlet. Mismatched families
(a C19 outlet to a C14 inlet) are allowed with a warning to check the cord.

### Power figures

On a device's **Power** tab: typical and maximum draw (W), and for UPSes and
PDUs their capacity (VA, W) and input voltage. For UPSes, add the runtime
curve from the datasheet (load in W → minutes); battery modules add their own
curve.

### The rack power summary

A rack's **Power** tab adds it all up per feed:

- each device's draw and what each UPS or PDU delivers;
- the **failover load**: what a feed carries if its partner fails;
- **UPS runtime** at the current and the failover load;
- outlets used per bank;
- warnings: overloaded, above 80%, a redundant pair that can't carry the
  load alone, devices with no cord, or no draw recorded.
