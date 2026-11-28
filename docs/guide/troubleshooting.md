# Troubleshooting

Start with the log:

```bash
cd rackpath
docker compose logs --tail 100 rackpath
```

For more detail, set `RACKPATH_LOG=debug` in `.env` and run
`docker compose up -d`; set it back to `info` afterwards.

## Installing and signing in

**I lost the first password.**
`docker compose logs rackpath | grep password`. If the log has rotated, or
for any user who's locked out:

```bash
docker compose exec rackpath rackpath reset-password admin
```

It prints a temporary password and signs that user out everywhere.

**The page won't load.**
- `docker compose ps`: is `rackpath` running and healthy?
- Is the port right? `RACKPATH_PORT` in `.env` (8080 by default). With Caddy,
  use `https://<name>` on 443 instead: Rackpath itself only listens on
  `127.0.0.1` then.
- A firewall on the server may block the port.

**The browser warns about the certificate (Caddy).**
Expected until you trust Caddy's root certificate; see
[Install → Trusting Caddy's certificate](installation.md#trusting-caddys-certificate).

**I'm signed out straight away, or sign-in loops (behind a proxy).**
Over HTTPS, `RACKPATH_COOKIE_SECURE` must be `true`; behind a proxy,
`RACKPATH_TRUST_PROXY=true`. Run `deploy.sh` again to set them, or edit
`.env`.

**Invitation links or QR codes point at the wrong address.**
Set `RACKPATH_PUBLIC_URL` to the address people use.

## Updating

**I pulled, but nothing changed.**
The published image is built from `main` a few minutes after each change.
Wait and pull again. `docker compose exec rackpath rackpath version` shows
what's running.

**update.sh stops: "These files have local changes".**
Someone edited files in the clone. See them with `git status`; keep them
with `git stash`, or undo them with `git checkout -- <file>`.

## Integrations

**Test connection fails.**
- The address must be reachable **from the Rackpath server** (try
  `curl -k https://192.168.1.1` there).
- UniFi: use the console's local address and a key or local user, not a
  UI.com cloud account. If the console has a self-signed certificate, untick
  *Check the server's certificate*.
- "The stored secret can't be read": `RACKPATH_ENCRYPTION_KEY` changed since
  it was saved. Enter the key or password again.

**A sync was held for approval.**
It would have changed more than the hold threshold. Open the integration,
check what it would do, then **Approve** or **Reject**. If the source really
changed that much, raise the threshold.

**Something I removed at the source is still in Rackpath.**
By default it's kept and marked *missing at source*. Turn on *Delete records
that are gone from the source* on the integration; see
[Integrations](integrations.md#when-something-disappears-at-the-source). A
device with documented cables is always kept: delete it by hand.

**Devices came in as Unplaced.**
That's expected: sources don't know which rack something is in. Edit each
device and choose its place.

## Network discovery

**"Can't send ping … allow them with the sysctl net.ipv4.ping_group_range".**
Your `docker-compose.yml` predates discovery. Get the current one (see
[Backups and updates](backups-and-updates.md#installed-with-deploysh)) or add
under the `rackpath` service:

```yaml
    sysctls:
      net.ipv4.ping_group_range: "0 2147483647"
```

then `docker compose up -d`.

**A scan found fewer hosts than I expected.**
Many devices don't answer ping (Windows firewall, phones asleep, IoT).
Add your router as an [SNMP device](discovery.md#snmp-devices): its ARP
table lists everything that has talked recently.

**"This prefix can't be scanned".**
It's larger than /22, public, or IPv6. Add the smaller prefixes inside it
and scan those.

**"Another scan or SNMP poll is running".**
One runs at a time. Wait for it to finish; scheduled runs queue by
themselves.

**SNMP Test says "No answer".**
- Is SNMP on, and is the device allowed to answer Rackpath's server? Many
  devices only answer listed addresses.
- With Docker's default network, the device sees the **server's** address,
  not the container's.
- Is UDP port 161 open between them?
- Check the version, community or user, and protocols match the device.

**SNMP Test says "refused the SNMPv3 user, passwords or protocols".**
The user, one of the passwords, or the authentication/privacy protocol
doesn't match. Rackpath offers SHA-1/SHA-2 and AES only; a device set to MD5
or DES won't work (use v2c, or change the device).

**Switch ports are missing for some hosts.**
A MAC seen only on a port with more than 16 MACs is treated as behind an
uplink. Poll the switch the device is actually plugged into.

## Still stuck?

Open an issue at <https://github.com/Stevy2191/Rackpath/issues> with what you
did, what you expected, and the relevant lines of the log (remove anything
private first).
