# Rackpath guide

Step-by-step help for installing Rackpath and documenting a network with it.
Start at the top if you're new; each page stands on its own if you're looking
something up.

## Getting started

1. [Install Rackpath](installation.md): the install script, HTTPS choices,
   ports, and the first sign-in.
2. [First steps](first-steps.md): your password, two-factor sign-in, your
   first project, and how codes work.
3. [Places, racks and devices](places-and-devices.md): sites, locations,
   floors, rooms, floor plans, racks and the devices in them.

## Documenting the network

- [Ports and cabling](cabling.md): ports, patch cords and permanent
  cabling, and tracing a connection end to end.
- [IP addresses](ip-addresses.md): prefixes, DHCP pools and other ranges,
  addresses, the address map, free addresses and warnings.
- [VLANs and Wi-Fi](vlans-and-wifi.md): VLANs, Wi-Fi networks and a
  port's VLANs.
- [Templates and power](templates-and-power.md): device templates with
  their port layout, and power outlets, cords and UPS runtime.

## Bringing data in

- [Integrations](integrations.md): UniFi, Zabbix, Windows DHCP/DNS and CSV
  files; what each brings, and what happens when something disappears.
- [Network discovery](discovery.md): finding hosts nobody documented with
  ping sweeps and SNMP, and reviewing what was found.

## Running Rackpath

- [Users and permissions](users-and-permissions.md): roles, invitations,
  and giving someone access to part of a project.
- [Reports, exports and moves](reports-and-moves.md): PDF reports with QR
  codes, bills of materials, CSV exports, diagrams, and moving things.
- [Backups and updates](backups-and-updates.md): what to back up, how to
  restore, and how to update.
- [Troubleshooting](troubleshooting.md): common problems and what to check.

## For developers

- [api-rs/README.md](https://github.com/Stevy2191/Rackpath/blob/main/api-rs/README.md): the server, its settings, the
  API and the security model.
- [docs/design/v2-data-model.md](https://github.com/Stevy2191/Rackpath/blob/main/docs/design/v2-data-model.md): the design
  and the decisions behind it.

## Reading this guide

The guide is plain Markdown in
[docs/guide](https://github.com/Stevy2191/Rackpath/tree/main/docs/guide), so
it reads well on GitHub. It is also published as a searchable website at
<https://stevy2191.github.io/Rackpath/>. To preview the site locally:

```bash
pip install -r docs/requirements.txt
mkdocs serve
```
