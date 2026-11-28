# Windows DHCP and DNS → Rackpath

Rackpath never logs in to your Windows servers. These two scripts run on
the Windows side and **push** the data to Rackpath:

| Script | What it does |
|---|---|
| `Push-RackpathDhcp.ps1` | Reads DHCP scopes (options 3, 6, 15), exclusions and reservations, static DNS A/AAAA/PTR records from the zones you list, and optionally leases; sends them to Rackpath. Read-only. |
| `Register-RackpathTask.ps1` | Installs the push script as a scheduled task (hourly by default) and stores the import token protected on the machine. |

Read both before running them: they're plain PowerShell.

## Set-up

1. In Rackpath, open the project → **Integrations** → add **Windows DHCP/DNS**.
   Copy the **import token** it shows (once).
2. On the DHCP server, as an administrator:

   ```powershell
   .\Register-RackpathTask.ps1 -RackpathUrl https://rackpath.example.com `
       -RunAs 'CORP\svc-rackpath$' `
       -DnsZones corp.example.com,30.20.10.in-addr.arpa `
       -RunNow
   ```

   It prompts for the token. Leave out `-RunAs` to run as SYSTEM.
3. Check the integration's sync history in Rackpath.

## Rights

The account the task runs as needs, and only needs:

- **DHCP:** membership of the local **DHCP Users** group on the DHCP server.
- **DNS:** read access to the zones you list (`Get-DnsServerResourceRecord`).
  On domain controllers, members of **DnsAdmins** can read zones but can also
  change them, so prefer a delegated read permission on the zone. Confirm
  the minimum on your domain before relying on it.

A **group managed service account (gMSA)** is recommended: no password to
store or rotate.

## How the token is kept

The token is written to `%ProgramData%\Rackpath\token.bin`, encrypted with
DPAPI in **machine scope**, and its access list allows only the task's
account, SYSTEM and Administrators. (Machine scope is used because the
installer can't encrypt as a gMSA; the access list is what keeps other
accounts out.) Rotate the token in Rackpath at any time; then run
`Register-RackpathTask.ps1` again with the new one.

## What Rackpath does with it

- Scopes become prefixes (with gateway, DNS servers and domain), DHCP
  ranges become DHCP pools split around exclusions, exclusions become
  reserved ranges, reservations become addresses marked as DHCP
  reservations, linked to the device with that MAC.
- Static DNS names fill in addresses' DNS names; a second name becomes an
  alias; a PTR that disagrees with the A record is reported.
- Records Windows no longer has are marked **missing**. They're only
  deleted if you turn on *Delete records that are gone from the source* on
  the integration.
- An import that would change more than half of what this integration
  owns at once is **held** for an admin to approve.
- One import per minute per token; HTTPS only (unless `-AllowHttp`).

## Without installing anything

Run `Export-DhcpServer -File dhcp.xml -Leases:$false` and upload the file on
the integration's page. That covers DHCP only (no DNS), and is handy for a
first load or a one-off site.

## Failover pairs

If two servers share scopes in a failover relationship, run the task on
one of them. Rackpath identifies scopes by scope ID rather than server, so
pushing from both doesn't create duplicates, but one source is simpler.
