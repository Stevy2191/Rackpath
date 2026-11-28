# Integrations

Integrations bring in what other systems already know, so you don't type it
twice. They **only read**: Rackpath never changes anything at the source.

Open the project → **Integrations** → **Add integration**. Only project
admins can manage integrations; everyone who can read the project can see
them (never their secrets).

| Source | How Rackpath gets the data | What comes in |
|---|---|---|
| **UniFi Network** | Rackpath calls the console's API | Gateways, switches and access points with their IPs; networks → VLANs and prefixes; DHCP ranges, DNS servers and fixed IPs; Wi-Fi networks; optionally current clients as a lease layer |
| **UniFi Protect / Access** | Same | Cameras; Access hubs and readers |
| **Zabbix** | Rackpath calls the Zabbix API | Hosts → devices with their IPs, vendor/model/serial/MAC, and an "Open in Zabbix" link. No monitoring data |
| **Windows DHCP/DNS** | A script on the Windows server pushes to Rackpath | Scopes → prefixes, DHCP pools, exclusions, reservations, static DNS names, optionally leases |
| **CSV files** | You upload them | Devices, ports, cables, prefixes, ranges, addresses |

## UniFi Network

1. **Create an API key** on the UniFi console. In recent UniFi Network
   versions it's under **Settings → Control Plane → Integrations → Create
   API Key**; menus move between versions, so look for "API" or
   "Integrations" if it isn't there. Copy the key.
   - Older consoles without API keys: create a **local** user (not a UI.com
     cloud account) with view-only rights, and use username and password.
2. In Rackpath: **Add integration** → *UniFi Network*:
   - **Address**: the console's local address, e.g. `https://192.168.1.1`.
   - **Sign in with**: API key (paste it) or username and password.
   - **Site**: `default` unless you renamed it in UniFi.
   - **Check the server's certificate**: untick only for a console with its
     self-signed certificate on a network you trust.
   - **Import DHCP ranges, DNS servers and fixed IPs**: leave on if UniFi
     runs DHCP; turn off where a Windows server does.
   - **Keep the current DHCP leases as a separate layer** (optional): shows
     connected clients on the address map and counts them as used. Never
     turned into documentation.
3. **Test connection** checks the address and key and counts what it can
   see.
4. **Preview** shows exactly what a sync would do without saving; **Sync
   now** does it.
5. Turn on **Sync automatically** (every 60 minutes by default) once you're
   happy.

What UniFi's records become:

- devices are named and **coded from their UniFi names** (`LIVING-ROOM-AP`)
  and land in **Unplaced**; put them in racks or rooms yourself;
- each network becomes a **VLAN** and a **prefix** with its gateway, and its
  DHCP range becomes a **DHCP pool**;
- a client with a fixed IP becomes a **DHCP reservation** if the IP is
  inside the DHCP range, or a **static** address if it's outside;
- Wi-Fi networks are imported without their passphrases.

## Zabbix

1. In Zabbix (5.4 or later), create an **API token** for a user whose role
   allows API access and who can read the host groups you want (*Users → API
   tokens*). A read-only user is enough.
2. In Rackpath: **Add integration** → *Zabbix*, address
   `https://zabbix.example.lan`, paste the token. Username and password also
   work.
3. **Test connection**, **Preview**, then **Sync now**.

Hosts become devices (in Unplaced) with their interface IPs and inventory
fields, plus an **Open in Zabbix** link. Rackpath brings no monitoring data:
no problems, graphs or availability.

## Windows DHCP and DNS

Rackpath never logs in to Windows servers. A PowerShell script on the DHCP
server **pushes** the data instead:

1. **Add integration** → *Windows DHCP/DNS*. Copy the **import token**: it's
   shown once.
2. On the DHCP server, from [tools/windows](https://github.com/Stevy2191/Rackpath/tree/main/tools/windows), as an
   administrator:

   ```powershell
   .\Register-RackpathTask.ps1 -RackpathUrl https://rackpath.example.com `
       -RunAs 'CORP\svc-rackpath$' `
       -DnsZones corp.example.com,30.20.10.in-addr.arpa `
       -RunNow
   ```

   It asks for the token, stores it protected on the machine, and installs
   an hourly scheduled task. Leave out `-RunAs` to run as SYSTEM.
3. Check the integration's sync history in Rackpath.

The account needs only membership of **DHCP Users** on the DHCP server and
read access to the DNS zones you list. A group managed service account
(gMSA) avoids storing a password. Details, and how to rotate the token:
[tools/windows/README.md](https://github.com/Stevy2191/Rackpath/blob/main/tools/windows/README.md).

**Without installing anything:** run
`Export-DhcpServer -File dhcp.xml -Leases:$false` and upload the file on the
integration's page (DHCP only, no DNS).

## CSV import

**Integrations → Import a CSV file** takes devices, ports, cables,
prefixes, ranges or addresses. **Download an empty file** gives you the
right columns; they're the same as the CSV exports, so you can also export a
table, fill it in, and import it.

- Places are given as paths relative to the project:
  `HQ/2/MDF/RK01/SW01/24`.
- **Check it** tests every row first. If any row fails, nothing is saved,
  and the errors are listed by row number. Fix them and check again.

## How syncing behaves

- **Matching:** each record is matched by the integration and the source's
  own ID, so syncing again updates rather than duplicates. Something you
  already documented by hand (a device with the same MAC, a prefix with the
  same CIDR, an address already documented) is **adopted** rather than
  duplicated.
- **What the source owns:** only the facts it brings (for a device:
  hostname, MAC, manufacturer, model, serial, firmware). Your codes, names,
  placement, notes and links are never overwritten.
- **Preview** shows exactly what a sync would do, without saving.
- **Big changes are held.** If a sync would change more than the integration's
  threshold (50% by default) of the records it owns, it's held until an
  admin approves or rejects it on the integration's page. This protects you
  from a misconfigured source wiping your documentation.
- Every sync is one entry in the **Activity** log, listing what changed.

## When something disappears at the source

By default, when a device, network, address or Wi-Fi network is no longer at
the source, Rackpath **keeps it** and marks it **missing at source**. It
shows a badge in lists and appears under IP addresses → Warnings. Nothing is
lost if the source was wrong for a moment.

If you'd rather have Rackpath clean up, edit the integration and turn on
**Delete records that are gone from the source**:

- the next sync deletes everything this integration owns that's gone,
  including records already marked missing;
- a device you've **documented cables on**, or that has devices on it, is
  **kept** and flagged, because deleting it would lose your work; delete it
  yourself if it's really gone;
- deletions show in **Preview**, count toward the hold threshold, and are
  listed in the Activity log.

## Secrets

API keys, tokens and passwords are encrypted with `RACKPATH_ENCRYPTION_KEY`
and never shown again (the form says whether one is set). The Windows import
token is stored only as a hash.
