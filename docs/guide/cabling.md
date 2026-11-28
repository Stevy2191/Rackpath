# Ports and cabling

## Ports

A device's ports come from its [template](templates-and-power.md), or you
add them on the device page: one at a time or **in bulk** (e.g. 48 ports
numbered `01`–`48`, or `G1`–`G4`).

Each port records:

- its **connector** (RJ45, SFP, SFP+, SFP28, QSFP, LC, SC, MPO, …) and, for
  SFP/QSFP cages, the **transceiver** plugged in (1000BASE-T, 10GBASE-SR,
  …). A module must fit its cage;
- speed, PoE, the interface name on the device (`Gi1/0/24`) and a MAC;
- its **VLANs** (see [VLANs and Wi-Fi](vlans-and-wifi.md)).

### Active and passive ports

- **Active** ports belong to equipment: switch ports, NICs, router
  interfaces. They have one side.
- **Passive** ports pass a signal through: patch panel ports and wall
  outlets. They have a **front** (where patch cords go) and a **rear** (the
  permanent cable in the wall or ceiling).

## Cables

Add a cable from a port (or the rack's patching view): choose the other
end, the **cable type** (Cat6, OM4, OS2, DAC, …), and optionally length,
colour, label and notes.

- **Permanent cables** join the rears of passive ports (panel to outlet).
- **Patch cords** join fronts (or a front and an active port).
- One cable per port side.

Rackpath checks the cable can physically work:

- **Refused:** things that can't be joined, like RJ45 to LC, a fibre cable on
  a copper port, or a QSFP DAC in an SFP+ port.
- **Accepted with a warning:** things that will probably fail or underperform,
  like single-mode fibre on a multimode optic, SR facing LR, Cat5e at 10G,
  copper over 100 m, or fibre longer than the optic reaches.

## Tracing

Open a port and choose **Trace** to follow the connection through every
patch panel and outlet to the far end. The trace shows each port and cable
in order, the total length, and any warnings at the link's real speed. A
chain is:

- **complete** when both ends are active ports (e.g. switch port → panel →
  wall outlet → a PC's network card);
- **incomplete** when it stops at a passive port;
- **unconnected** with no cables.

You can give a whole chain one **colour** to match the cables in the rack.

## The patching view

Each rack has a **patching** tab listing every port in the rack with the
cables on both sides, its VLANs and where the chain ends. It's the page to
print before rearranging a rack.

## When devices move

- Within the same floor, cables stay.
- Moving to another floor removes cables to things that don't move with it.
- Unplaced devices can't be cabled.

Every removed cable is listed in the change history (**Activity**).
