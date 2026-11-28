# IP addresses

Open **IP addresses** in the sidebar. Rackpath keeps your address plan:
**prefixes** (subnets), the **ranges** inside them, and the **addresses**
in use. IPv4 and IPv6 both work.

## Prefixes

**Add prefix** and type it in CIDR form: `10.20.30.0/24`. Host bits must be
zero: `10.20.30.7/24` is refused with "did you mean 10.20.30.0/24?".

- Prefixes **nest by themselves**: put `10.20.0.0/16` in and then
  `10.20.30.0/24`, and the /24 shows inside the /16. Nothing to link by hand.
- Each prefix can have a **role** (users, servers, management, voice,
  printers, IoT, guest, transit, WAN, loopback, other), a status (planned,
  active, deprecated), a **VLAN**, a **location**, a gateway, DNS servers and
  a domain name.
- The **Used** bar counts documented addresses, current DHCP leases (if an
  integration keeps them) and live hosts found by
  [discovery](discovery.md). Each address counts once. A DHCP pool is room
  for clients, not usage, so an empty pool doesn't fill the bar.

## Ranges

A range is a block of addresses inside one prefix. There are three kinds:

| Kind | Meaning | Usually comes from |
|---|---|---|
| **DHCP pool** | Addresses the DHCP server hands out | UniFi networks, Windows scopes, or by hand |
| **Reserved** | A block held back: don't use it | Windows DHCP exclusions, or by hand |
| **Static assignments** | A block set aside for static addresses | By hand |

Ranges in one prefix can't overlap.

## Addresses

An address is documented when it's in use (or about to be). Add one with
**Add address**, by clicking a free cell on the address map, or with **Next
free address** on a prefix.

Each address can be linked to a **device**, and to the **port** it's on. It
can also have a MAC, a DNS name and aliases, a role (primary, secondary,
gateway, VIP, loopback) and a description.

### Static, DHCP and DHCP reservation

Rackpath works out how each address is given out:

| Type | Meaning |
|---|---|
| **Static** | Outside every DHCP pool: set on the device itself |
| **DHCP reservation** | Pinned to a MAC address in the DHCP server |
| **DHCP** | Inside a DHCP pool and not pinned |

You don't pick this from a list. Mark an address as a **DHCP reservation**
(with its MAC) and Rackpath works out the rest from the DHCP pools. The
address list and the address map colour addresses by type.

## The address map

IPv4 prefixes of /22 or smaller show an **address map**: one cell per
address, coloured for static, DHCP reservation, DHCP, DHCP pool, reserved
range, gateway and (optionally) current DHCP leases.

- Click a documented address to open it.
- Click a free cell to document that address.

## Free addresses

Each prefix lists its **free addresses** as runs (`10.30.5.3 – 10.30.5.99`),
split into:

- **free outside the DHCP pools**: for static use;
- **free inside the pools**: DHCP will hand those out.

Taken: documented addresses, current leases, live hosts found by discovery,
the gateway, reserved ranges, and smaller prefixes inside this one. **Use**
on a run starts a new address there. **Next free address** picks the first
free one outside the pools.

## Warnings

The **Warnings** tab lists things that are probably mistakes:

- an address outside every prefix (public addresses, such as a router's
  WAN address, aren't flagged);
- a static address inside a DHCP pool;
- the same MAC on two DHCP reservations;
- an address on a port whose VLANs don't include the prefix's VLAN;
- a users/servers/voice/printers/IoT prefix with no VLAN;
- records an integration no longer has;
- from [discovery](discovery.md): a different MAC answering at a documented
  address, or a documented address in a scanned prefix that hasn't answered
  for 30 days.

## Address spaces

Every project has a **Default** space. Add another only when the same
private range really exists twice, in separate routing domains (for example
two customers both using `192.168.1.0/24`). Each integration and SNMP device
can be pointed at a space.
