# Network discovery

Documentation only knows what someone wrote down. **Discovery** finds what
nobody did: the static IP set on a printer years ago, the box under a desk.
Rackpath does it in the two ways enterprise IPAM tools do, both **off until
an admin turns them on**:

- **Ping sweeps** of a prefix: who answers?
- **SNMP reads** of routers and switches: which IP has which MAC (the
  router's ARP table), and which switch port each MAC is on (the switch's
  MAC address table).

What discovery finds **never becomes documentation by itself.** It goes to a
review list where someone documents or ignores each host.

## Ping sweeps

### Turn on scanning for a prefix

1. Open **IP addresses** → a prefix.
2. On the **Discovery** card, choose **Scan settings**.
3. Tick **Scan this prefix** and pick a **schedule**: by hand only, or every
   hour, 6 hours, day or week.
4. Save. **Scan now** appears; use it any time.

Only admins can change scan settings or scan.

### What a sweep does

- Each usable address in the prefix gets **one ping** with a 1-second
  timeout, 32 at a time. A /24 takes a few seconds; a /22 (the largest
  allowed) at most about half a minute.
- Hosts that answer get a reverse DNS lookup for their name.
- One sweep or SNMP poll runs at a time across the whole server.

### What can be swept

| Allowed | Not allowed |
|---|---|
| Private IPv4: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 | Public addresses |
| Prefixes of /22 (1,024 addresses) or smaller: /22, /23, /24, … | /21 and larger: scan the smaller prefixes inside instead |
| | IPv6 (a /64 can't be swept; use SNMP) |

A prefix that can't be scanned says why on its Discovery card.

### Firewalls

A host that blocks ping (Windows' default firewall, many IoT devices) won't
answer a sweep. SNMP reads of your router's ARP table still see it. Using
both gives the best picture.

## SNMP devices

SNMP gives **MAC addresses and switch ports**, which ping can't, because
Rackpath usually sits behind Docker's network and can't see MACs itself.

### 1. Turn on SNMP on the device

Enable SNMP **read-only** on your router or layer 3 switch (for ARP) and your
switches (for MAC tables). Prefer **SNMPv3** with authentication and
privacy (encryption):

- **User**: e.g. `rackpath`
- **Authentication**: SHA-256 (or SHA-384/512; SHA-1 works but is weak)
- **Privacy**: AES-128 (or AES-192/256)

Allow SNMP only from Rackpath's server address if the device can restrict it.

> **UniFi:** turn on *SNMP Monitoring* → *Version 3* in the UniFi Network
> settings (search for "SNMP"), with a username and one password. UniFi's
> protocols are fixed: in Rackpath choose **Authentication: SHA-1** and
> **Privacy: AES-128**, and type UniFi's one password into **both** password
> fields. Rackpath warns that SHA-1 is weak; UniFi offers nothing stronger,
> and the traffic is still encrypted with AES. The same settings work for
> UniFi switches; add each switch as its own SNMP device to get ports. Once
> v3 works, turn *Version 1/2C* off in UniFi.
>
> Other devices that only offer MD5 or DES for SNMPv3 can't be used with v3:
> those are broken. Use **v2c** with a long random read-only community
> instead, and keep SNMP on the management network.

### 2. Add it in Rackpath

1. **IP addresses** → **SNMP devices** → **Add SNMP device**.
2. **Name** and **IP address** (a private address, not a host name, so DNS
   can't redirect polling elsewhere).
3. **Version**: SNMPv3 (recommended), with the user, authentication and
   privacy settings above; or v2c with the community.
4. Choose what to read: **ARP table** (routers), **MAC address table**
   (switches), or both.
5. Pick a **schedule** (or by hand only) and save.
6. **Test** reads the device without saving and says how many entries it
   found. Then **Poll now**.

Credentials are stored encrypted and never shown again; leave a password
field empty when editing to keep the stored one.

### What a poll does

- Reads the device's name, its ARP table and/or its MAC address table, with
  read-only SNMP requests (Rackpath has no SNMP write at all).
- Keeps only addresses inside your **documented prefixes**.
- Works out each MAC's **switch port**. A port carrying more than 16 MACs is
  treated as an uplink, not where a device is plugged in.

## Reviewing what was found

**IP addresses** → **Discovered** lists live hosts at addresses nobody has
documented (each prefix's Discovery card lists its own). For each you see
the address, DNS name, MAC, switch port, how it was seen (ping, SNMP) and
when. If its MAC is already documented at another address, that's shown too:
it may have moved.

- **Document** creates the address with its MAC and DNS name (you can add a
  description) and takes it off the list. Link it to a device afterwards.
- **Ignore** hides it for good (guest phones, a test laptop). **Show
  ignored** → **Restore** brings it back.
- Hosts waiting for review that aren't seen for 30 days are forgotten.

Editors can document and ignore; only admins scan.

## What discovery changes elsewhere

- **Documented addresses** show **Last seen**, the **MAC seen** and the
  **switch port** on their page.
- **Usage, Next free and Free addresses** count live discovered hosts as
  used, so Rackpath won't offer an address something is already on.
- **Warnings** (IP addresses → Warnings):
  - *mac changed*: a different MAC answered at a documented address
    (replaced hardware, or an IP conflict);
  - *not seen*: a documented address in a scanned prefix hasn't answered for
    30 days (retired, or behind a firewall).

## Security summary

- Off by default, per prefix and per SNMP device; admins only.
- Private ranges only; /22 or smaller; never IPv6 sweeps.
- One ping per address, 32 at a time, at most hourly on a schedule.
- SNMP read-only; v3 with encryption by default; v1 and MD5/DES not offered.
- Credentials encrypted with `RACKPATH_ENCRYPTION_KEY`, write-only.
- Every scan, poll, settings change and review action is in the Activity log.
- The container gets no extra capabilities; see
  [Install](installation.md#network-discovery-and-the-container).
