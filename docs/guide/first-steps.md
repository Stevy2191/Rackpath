# First steps

## Your account

After the first sign-in (see [Install](installation.md#first-sign-in)):

1. Open **Account** in the sidebar.
2. **Turn on two-factor sign-in.** Scan the QR code with an authenticator
   app (Microsoft Authenticator, Google Authenticator, 1Password, Bitwarden…),
   type a code to confirm, and **save the recovery codes** somewhere safe.
   Each recovery code signs you in once if you lose your phone.
3. As an account administrator you can **require two-factor sign-in for
   everyone**: **Users and access** → **Account settings** → *Everyone must
   use two-factor sign-in*. People without it are asked to set it up at
   their next sign-in.

The first user, `admin`, is the **owner**: nobody else can disable, delete or
reset them. Ownership can be handed to another user later.

## Projects

Everything in Rackpath lives in a **project**: a separate set of sites,
devices, addresses and integrations. Most organisations need one; use more
when parts of the network are run by different people or should be kept
apart (a customer each, for an MSP).

1. Open **Projects** → **New project**.
2. Give it a short **code** (e.g. `ACME`) and a name. The code starts every
   path in Rackpath: `ACME/HQ/2/MDF/RK01/SW01`.

The sidebar shows the current project. Rackpath remembers the last one you
used, also on account pages.

## Codes and paths

Every place and device has a short uppercase **code**, unique among its
neighbours, and a **path** built from the codes:

```
ACME / HQ / 2 / MDF / RK01 / SW01 / 24
project  location  floor  room  rack  device  port
```

- Codes are 1–16 characters. Leave the code empty when adding a device and
  Rackpath picks the next free one from the device type (`SW01`, `SW02`…).
- Devices brought in by an integration get a code made from their name
  (`LIVING-ROOM-AP`), which you can change.
- A device also has a free-text **name**, shown next to its code.
- Paths are what you see in search, on labels, in PDF reports and in CSV
  files.

## Finding things

The **search** box at the top finds places, devices, ports and addresses by
code, name, hostname, MAC, serial number, asset tag, IP address or DNS name,
across every project you can see.

## What next

- Draw your sites: [Places, racks and devices](places-and-devices.md).
- Or pull in what you already have: [Integrations](integrations.md).
- Invite your team: [Users and permissions](users-and-permissions.md).
