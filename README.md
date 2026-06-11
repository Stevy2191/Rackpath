# Rackpath

Self-hosted network topology and rack management web app.

## Stack

- **Frontend**: React + React Flow (topology diagram) + custom rack builder UI, served via nginx
- **API**: Node.js + Express + MariaDB (`mysql2` driver), JWT-based authentication
- **Scanner**: Python service using `nmap`, `puresnmp`, `scapy`, `zeroconf` (mDNS), `manuf` (MAC OUI), and `impacket` (NetBIOS) for enhanced network discovery, streaming per-host results back to the API
- **Database**: MariaDB

## Project layout

```
Rackpath/
├── deploy.sh   # Automated fresh-install script
├── frontend/   # React app (React Flow topology, rack builder, device & scan pages)
├── api/        # Express API + MariaDB access layer
├── scanner/    # Python discovery service (nmap/snmp/lldp/arp), exposes a REST API
├── db/         # MariaDB schema init scripts
└── .github/    # CI workflows (build & publish images to GHCR)
```

## Prerequisites

- [Docker Engine](https://docs.docker.com/engine/install/)
- [Docker Compose plugin](https://docs.docker.com/compose/install/) (`docker compose ...`) - `docker-compose` v1 also works as a fallback
- `curl` and `openssl` (used by `deploy.sh`)

## Quick start: `deploy.sh`

The fastest way to stand up a fresh instance is the included deploy script.
It creates a deployment directory, downloads the compose config, prompts for
a JWT secret and admin password, starts the stack, applies the database
schema, and creates the default admin user.

Run it directly from the repo:

```bash
./deploy.sh
```

Or fetch and run it without cloning the repo:

```bash
curl -fsSL https://raw.githubusercontent.com/Stevy2191/Rackpath/main/deploy.sh | bash
```

By default this creates a `rackpath/` directory in the current working
directory containing `docker-compose.yml`, `.env`, and `db/init.sql`. Set
`RACKPATH_DEPLOY_DIR=/path/to/dir` to install elsewhere.

During setup you'll be prompted for:

- **JWT signing secret** - leave blank to auto-generate a secure random value (recommended)

When it finishes, it prints the URL, login credentials, and the path to
your `.env` file.

## Manual setup (fallback)

If you'd rather set things up by hand, or need to customize the compose
file:

1. Get the compose config (clone the repo, or download `docker-compose.yml`,
   `.env.example`, and `db/init.sql` individually).

2. Copy the environment template and fill in secrets:

   ```bash
   cp .env.example .env
   ```

   At minimum, set `RACKPATH_JWT_SECRET` to a long random value
   (`openssl rand -hex 32`).
   See the comments in `.env.example` for what every variable controls.

3. Start the stack (pulls pre-built images from GHCR by default):

   ```bash
   docker compose up -d
   ```

4. Wait for `rackpath-db` to report healthy:

   ```bash
   docker compose ps
   ```

5. The database schema in `db/init.sql` is applied automatically by MariaDB
   on first startup (it's mounted into `/docker-entrypoint-initdb.d/`). If
   you need to (re-)apply it manually, it's safe to re-run:

   ```bash
   docker compose exec -T rackpath-db sh -c 'exec mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' < db/init.sql
   ```

6. Create the default admin user:

   ```bash
   docker compose exec rackpath-api npm run seed
   ```

7. Open the frontend at `http://localhost:8080` (or `FRONTEND_PORT` from `.env`).

### Building locally instead of pulling

To build all images from source instead of pulling from GHCR:

```bash
docker compose build
docker compose up -d
```

## Services and ports

| Service              | Description                                 | Default port | `.env` variable  |
|----------------------|----------------------------------------------|---------------|-------------------|
| `rackpath-frontend`  | React UI served via nginx                   | 8080          | `FRONTEND_PORT`   |
| `rackpath-api`       | Express API backed by MariaDB               | 3010          | `API_PORT`        |
| `rackpath-scanner`   | Python discovery service (host networking)  | 5001          | `SCANNER_PORT`    |
| `rackpath-db`        | MariaDB with persistent named volume        | 3306          | `DB_PORT`         |

### A note on the scanner and `network_mode: host`

`rackpath-scanner` runs with `network_mode: host` so it can perform ping
sweeps, ARP probes, and SNMP/LLDP discovery directly on your LAN - this
doesn't work from an isolated bridge network. Because of this:

- Its published port (`SCANNER_PORT`, default 5001) is bound directly on the
  host, not via a compose `ports:` mapping.
- The API reaches it via `SCANNER_URL` (default
  `http://host.docker.internal:5001`), and the scanner calls back into the
  API via `API_PUBLIC_URL` (default `http://localhost:3010`).
- `SCAN_INTERFACE` should be set to the host network interface you want
  scans to run on (default `eth0`).

## Login and authentication

Rackpath requires a login. The seed script (`npm run seed`, run
automatically by `deploy.sh`) creates a default user:

- **Username**: `admin`
- **Password**: `rackpath`

This account has `must_change_password` set, so you'll be redirected to a
change-password screen immediately after the first login. The JWT used for
sessions is signed with `RACKPATH_JWT_SECRET` - keep this value secret, and
changing it invalidates all existing sessions.

## Pages

- `/topology` — React Flow canvas of discovered devices and links
- `/racks` — Rack builder: create racks and place devices into U slots
- `/devices` — Device list with an editable detail form and per-port editor (cabling/connections)
- `/scan` — Default landing page. Configure and start subnet scans, watch
  results stream in live, sort/export them, and select hosts to import into
  inventory; a sidebar lists past scans by name and date

A light/dark theme toggle is available in the navbar; the choice is remembered
per-browser.

## Scanner capabilities

Slitheris-style enhanced discovery runs in parallel per host:

- Multi-method liveness: ICMP ping, TCP probe (80/443/22), and a UDP probe — a
  host is marked **up** if any method responds
- Nmap SYN scan (`-sS`) with OS detection and the top 100 ports (`-F`)
- NetBIOS/SMB query (`nmblookup`, impacket fallback) for the Windows machine
  name and workgroup/domain
- mDNS/Bonjour browse (zeroconf) for `.local` hostnames and Apple/printer/IoT
  service advertisements
- SNMP v2c walk for `sysName`/`sysDescr`/`sysContact`/`sysLocation`, the
  interface table, and ARP table
- LLDP/CDP neighbor discovery via SNMP OIDs
- MAC OUI → vendor lookup via the bundled Wireshark database (`manuf`)
- Device-type inference (Router, Switch, Firewall, Server, Windows PC, Mac,
  Linux, Printer, AP, IP Camera, IoT, NAS, Unknown) from the combined signals

As each host is fully enriched the scanner POSTs it to the API immediately, and
the API streams it to the browser over **Server-Sent Events**
(`GET /api/scans/:id/stream`) so the results table populates row by row in real
time. A progress bar tracks hosts scanned vs. total hosts in the subnet, and
live counters show found / up / down.

Past scans are listed by name and date (`GET /api/scans`); selecting one
reloads its stored results (`GET /api/scans/:id/results`). Results can be
exported to PDF or CSV from the `/scan` page.

Results are returned as structured JSON and stored on the scan job, but
devices found during a scan are **not** added to your inventory
automatically. Review the discovered devices on the `/scan` page, select the
ones you want, and click "Add Selected" to import them into the
devices/ports tables.

## CI/CD

`.github/workflows/docker-publish.yml` builds and pushes the frontend, API,
and scanner images to GHCR (`ghcr.io/stevy2191/rackpath-*`) on every push to
`main`.
