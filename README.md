<p align="center">
  <img src="docs/banner.svg" alt="Rackpath — network documentation and infrastructure management for IT teams and homelabs" width="100%" />
</p>

<p align="center">
  <strong>Network documentation and infrastructure management for IT teams and homelabs</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Stevy2191/Rackpath?style=flat-square" alt="License"></a>
  <a href="https://github.com/Stevy2191/Rackpath/stargazers"><img src="https://img.shields.io/github/stars/Stevy2191/Rackpath?style=flat-square" alt="GitHub stars"></a>
  <img src="https://img.shields.io/badge/version-0.1.0-4adede?style=flat-square" alt="Version">
</p>

---

## What is Rackpath?

Rackpath is self-hosted documentation software for IT infrastructure. It
records what you have and how it's connected (network topology diagrams,
visual rack layouts, device inventory, VLAN plans) in a single web app, so
you always have an up-to-date picture of what's running where, whether you're
managing a business network or a homelab.

Rackpath documents your network; it doesn't probe or monitor it. It never
scans your LAN, polls devices, or stores device logins. Inventory comes from
you and from the systems you already run (UniFi, NetBox, LibreNMS, Zabbix).

Everything runs in your own environment via Docker Compose: your data never
leaves your infrastructure.

## ✨ Features

- 🗺️ **Interactive Network Topology** — drag-and-drop canvas with animated
  links and interface labels
- 🗄️ **Visual Rack Builder** — front/back views, vendor catalog, multi-rack
  support
- 📋 **Device Inventory** — tags, locations, bulk editing, ports and cabling
- 🔗 **Integrations** — import inventory from UniFi, UniFi Protect, UniFi
  Access, Zabbix, LibreNMS and NetBox
- 🌐 **VLAN Planning** — subnet management and zone visualization
- 📊 **Project Dashboard** — site overview with warnings and activity log
- 📦 **Project Templates** — starter topologies for common setups
- 🏢 **Multi-site** — manage multiple sites as separate projects

## 📸 Screenshots

| Dashboard | Topology |
|---|---|
| ![Dashboard](docs/screenshots/dashboard.png) | ![Topology](docs/screenshots/topology.png) |
| Project overview with warnings and recent activity | Drag-and-drop network topology canvas |

| Rack Builder | Device Inventory |
|---|---|
| ![Rack Builder](docs/screenshots/rack-builder.png) | ![Device Inventory](docs/screenshots/devices.png) |
| Front/back rack views with a vendor catalog | Inventory list with tags and locations |

| Integrations |
|---|
| ![Integrations](docs/screenshots/integrations.png) |
| Connect UniFi, Zabbix, LibreNMS, NetBox, and more |

*Don't see images above? Add screenshots to [`docs/screenshots/`](docs/screenshots/) — see that folder's README for filenames.*

## 🚀 Quick Start

```bash
curl -fsSL https://raw.githubusercontent.com/Stevy2191/Rackpath/main/deploy.sh | bash
```

This downloads the compose config, asks which ports to use and for a JWT
secret, starts the stack, applies the database schema, and creates the
default admin user.

Once it finishes, open the URL it prints — by default:

```
http://your-server-ip:8080
```

**Default login:** `admin` / `rackpath` — you'll be required to change this
password immediately on first login.

> Prefer to set things up by hand or build from source? See
> [Manual setup](#manual-setup) below.

## 🛠️ Tech Stack

- **Frontend**: React + AntV X6 (topology diagram), custom rack builder UI, served via nginx
- **Backend**: Node.js + Express, JWT-based authentication
- **Database**: MariaDB
- **Deployment**: Docker Compose

```
Rackpath/
├── deploy.sh   # Automated fresh-install script
├── frontend/   # React app (AntV X6 topology, rack builder, device pages)
├── api/        # Express API + MariaDB access layer
├── db/         # MariaDB schema init scripts
└── .github/    # CI workflows (build & publish images to GHCR)
```

## Manual setup

### Prerequisites

- [Docker Engine](https://docs.docker.com/engine/install/)
- [Docker Compose plugin](https://docs.docker.com/compose/install/) (`docker compose ...`) - `docker-compose` v1 also works as a fallback
- `curl` and `openssl` (used by `deploy.sh`)

### Using `deploy.sh`

The fastest way to stand up a fresh instance is the included deploy script.
It creates a deployment directory, downloads the compose config, prompts for
ports and a JWT secret, starts the stack, applies the database schema, and
creates the default admin user (`admin` / `rackpath`, changed on first login).

Run it directly from the repo:

```bash
./deploy.sh
```

Or fetch and run it without cloning the repo (same command as Quick Start):

```bash
curl -fsSL https://raw.githubusercontent.com/Stevy2191/Rackpath/main/deploy.sh | bash
```

By default this creates a `rackpath/` directory in the current working
directory containing `docker-compose.yml`, `.env`, and `db/init.sql`. Set
`RACKPATH_DEPLOY_DIR=/path/to/dir` to install elsewhere.

During setup you'll be prompted for:

- **Ports** for the web UI and the database - press Enter to take
  the default shown for each. If a port is already in use the script says so
  and asks again, so you can route around a conflict during the install
  rather than afterwards.
- **JWT signing secret** - leave blank to auto-generate a secure random value (recommended)

On a fresh install it also generates random database passwords and a
credential encryption key (`RACKPATH_ENCRYPTION_KEY`), and restricts `.env`
to owner-only permissions.

Re-running the script is safe: it offers your current ports as the defaults
and keeps the existing JWT secret, database passwords and encryption key
rather than resetting them.

To install without a terminal — a `curl ... | bash` pipe has none, and
neither does a provisioning script — set any of these first and the matching
question is skipped:

```bash
RACKPATH_FRONTEND_PORT=9090 \
RACKPATH_DB_PORT=3307 \
  bash deploy.sh
```

When it finishes, it prints the URL, login credentials, the ports in use,
and the path to your `.env` file.

### Setting things up by hand

If you'd rather set things up by hand, or need to customize the compose
file:

1. Get the compose config (clone the repo, or download `docker-compose.yml`,
   `.env.example`, and `db/init.sql` individually).

2. Copy the environment template and fill in secrets:

   ```bash
   cp .env.example .env
   ```

   At minimum, set `RACKPATH_JWT_SECRET` and `RACKPATH_ENCRYPTION_KEY` to
   random values (`openssl rand -hex 32` for each), and replace the `changeme_*` database
   passwords **before the first start** (MariaDB only reads them when it
   creates its data volume). Then restrict the file: `chmod 600 .env`.
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
   on first startup (it's mounted into `/docker-entrypoint-initdb.d/`). Only
   if the database has no tables at all (for example, a data volume created
   without it), apply it by hand:

   ```bash
   docker compose exec -T rackpath-db sh -c 'exec mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' < db/init.sql
   ```

   On every startup, the API also applies any pending SQL files in
   `api/src/db/migrations/` (tracked in a `schema_migrations` table), so
   schema changes shipped after your initial deploy are picked up
   automatically.

6. Create the default admin user:

   ```bash
   docker compose exec rackpath-api npm run seed
   ```

7. Open the frontend at `http://localhost:8080` (or `FRONTEND_PORT` from `.env`).

#### Building locally instead of pulling

To build all images from source instead of pulling from GHCR:

```bash
docker compose build
docker compose up -d
```

### Services and ports

| Service              | Description                                 | Default port | `.env` variable  |
|----------------------|----------------------------------------------|---------------|-------------------|
| `rackpath-frontend`  | React UI served via nginx; proxies `/api/`  | 8080          | `FRONTEND_PORT`   |
| `rackpath-api`       | Express API backed by MariaDB               | none (internal) | —               |
| `rackpath-db`        | MariaDB with persistent named volume        | 3306 (localhost only) | `DB_PORT` |

`deploy.sh` asks for both ports during install. To change one later, edit
`.env` and run `docker compose up -d`; no rebuild is needed.

The API has no port on the host. The web UI's nginx proxies `/api/` to it
inside the compose network, so the web UI port is the only thing exposed to
your network.

`DB_PORT` is published on `127.0.0.1` only, so MariaDB is reachable from
the Docker host itself (a GUI client over an SSH tunnel, a backup job) but
not from the network. The API talks to it over the compose network either
way. To stop publishing it at all, delete the `ports:` block from
`rackpath-db` in `docker-compose.yml`.

## 🔒 Security

- **Nothing probes your network.** Rackpath doesn't scan, poll or log in to
  devices, so it stores no device credentials. The only secrets it keeps are
  the integration logins and API keys you give it.
- **Stored credentials** (integration passwords and API keys) are encrypted
  with AES-256-GCM using `RACKPATH_ENCRYPTION_KEY`, and are never sent back
  to the browser. Back up `.env` along with the database: if the key is lost
  or changed, those credentials have to be re-entered.
- **First login.** Until the default `admin` password is changed, the API
  refuses every request except changing the password.
- **Logins** are limited to 10 failed attempts per username (and 50 per IP)
  every 15 minutes. Changing a password signs out every other session.
- **HTTPS.** If you put Rackpath behind a TLS reverse proxy, set
  `COOKIE_SECURE=true` so the session cookie is only sent over HTTPS.
- **Cross-origin access** to the API is off by default. Set `CORS_ORIGINS`
  only if you run the frontend from a different origin (e.g.
  `http://localhost:3000` during frontend development).

### Changing the database passwords

To change the database passwords after install (for example on an install
still using the `changeme_*` defaults), change them in the database first,
then in `.env`:

```bash
docker compose exec rackpath-db sh -c 'exec mariadb -uroot -p"$MYSQL_ROOT_PASSWORD"'
```

```sql
ALTER USER 'root'@'%' IDENTIFIED BY 'new-root-password';
ALTER USER 'root'@'localhost' IDENTIFIED BY 'new-root-password';
ALTER USER 'rackpath'@'%' IDENTIFIED BY 'new-app-password';
```

Then set `MYSQL_ROOT_PASSWORD`, `MYSQL_PASSWORD` and `DB_PASSWORD` to the new
values in `.env` and run `docker compose up -d`.

## 📖 Usage

### Pages

- `/dashboard` — Project overview: site elevation, warnings, and recent activity
- `/topology` — AntV X6 canvas for network diagrams (devices, zones, shapes,
  labels, and links with interface/VLAN details); a project can hold
  multiple topologies
- `/racks` — Rack builder: front/back views, vendor catalog, U-slot
  placement, and PDU/UPS power planning
- `/devices` — Device inventory with tags, bulk edit, and a per-port editor; sub-pages for network devices (`/devices/network`),
  cameras (`/devices/cameras`), and access-control devices (`/devices/access`)
- `/vlans` — VLAN and subnet planning
- `/locations` — Locations and rooms that racks and devices are assigned to
- `/integrations` — Import inventory from UniFi, UniFi Protect, UniFi Access,
  Zabbix, LibreNMS and NetBox. Integrations import what exists (names,
  models, serial numbers, MAC and IP addresses), not live state such as
  online status or door locks

A light/dark theme toggle is at the bottom of the side navigation rail; the
choice is remembered per-browser.

### Projects (multi-site)

Rackpath data is organized into **projects** — each project has its own
isolated set of devices, ports, racks, topologies, and integrations. A project
switcher in the side navigation rail shows the current project and lets you switch
between projects, create new ones, and rename or delete existing ones. The
**Default Project** is created automatically and cannot be deleted.

## 🗺️ Roadmap

Planned work and known issues are tracked in
[GitHub Issues](https://github.com/Stevy2191/Rackpath/issues). Feature
requests and bug reports are welcome there.

## 🤝 Contributing

Contributions are welcome!

1. Fork the repo and create a feature branch
2. Make your changes (see `CLAUDE.md` for database migration conventions —
   any new table/column/index needs a matching file in
   `api/src/db/migrations/` in the same commit)
3. Open a pull request describing your change

`.github/workflows/docker-publish.yml` builds and publishes the frontend
and API images to GHCR (`ghcr.io/stevy2191/rackpath-*`) on every
push to `main`.

## 📄 License

Rackpath is licensed under the [MIT License](LICENSE).
