<p align="center">
  <img src="docs/banner.svg" alt="Rackpath — network documentation and infrastructure management for IT teams and homelabs" width="100%" />
</p>

<p align="center">
  <strong>Network documentation for IT teams and homelabs</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Stevy2191/Rackpath?style=flat-square" alt="License"></a>
  <a href="https://github.com/Stevy2191/Rackpath/stargazers"><img src="https://img.shields.io/github/stars/Stevy2191/Rackpath?style=flat-square" alt="GitHub stars"></a>
  <img src="https://img.shields.io/badge/version-2.0.0-4adede?style=flat-square" alt="Version">
</p>

---

## What is Rackpath?

Rackpath is self-hosted documentation software for IT infrastructure. It
records what you have, where it is and how it's connected: sites, floors and
rooms, racks and the devices in them, every port and cable, IP plans, VLANs
and Wi-Fi, power, and network diagrams.

Rackpath documents your network; it doesn't probe or monitor it. It never
scans your LAN, polls devices or stores device logins. Inventory comes from
you and from systems you already run: UniFi, Zabbix and your Windows DHCP/DNS
servers, which push to Rackpath rather than being logged in to.

It's one small container (or one binary) with its data in one SQLite file.

## ✨ Features

- 🏢 **Sites, floors and rooms**, with floor plans you upload and draw rooms
  on, and racks and floor-standing devices placed on them
- 🗄️ **Rack elevations**, front and rear, in half-U steps with zero-U side
  mounts; click a free U to add a device, drag to move it
- 🔌 **Ports and cabling**: patch cords and permanent cabling through patch
  panels and wall outlets, connector and optic compatibility checks (RJ45,
  SFP/SFP+/SFP28/QSFP, LC/SC/MPO, Cat5e–Cat8, OM1–OM5, OS1/OS2, DAC/AOC), and
  end-to-end tracing of every chain
- 🌐 **IP address management**: prefixes that nest by themselves, DHCP pools
  and reserved ranges, an address map, next free address, and warnings
- 🏷️ **VLANs and Wi-Fi networks** on ports, and **tags** on devices
- 🧩 **Device templates** with a port layout designer; editing a template
  updates every device made from it, after showing exactly what changes
- ⚡ **Power**: outlets, inlets and cords, load and failover load per feed,
  UPS runtime with battery modules
- 🔗 **Integrations**: UniFi Network (with DHCP), UniFi Protect and Access,
  Zabbix, Windows DHCP/DNS (pushed by a PowerShell script), and CSV import,
  with safeguards against an import changing too much at once
- 🗺️ **Diagrams** whose links can be backed by documented cables
- 📄 **PDF reports** with a QR code on every section, **bills of materials**,
  and CSV exports
- 🚚 **Moves** of devices, racks, floors and whole locations (also between
  projects), previewed before they happen
- 👥 **Users, roles and invitations**: reader, editor or admin of every project,
  one project, or part of one; two-factor sign-in; a full change history

## 📸 Screenshots

| Floor plan | Rack elevation |
|---|---|
| ![Floor plan](docs/screenshots/floor-plan.png) | ![Rack elevation](docs/screenshots/rack-elevation.png) |

| Patching | Cable trace |
|---|---|
| ![Rack patching view](docs/screenshots/rack-patching.png) | ![Port and its traced chain](docs/screenshots/port-trace.png) |

| IP address map | Template designer |
|---|---|
| ![Prefix with its address map](docs/screenshots/prefix.png) | ![Template designer](docs/screenshots/template-designer.png) |

## 🚀 Install

```bash
curl -fsSL https://raw.githubusercontent.com/Stevy2191/Rackpath/main/deploy.sh | bash
```

This creates a `rackpath/` folder with `docker-compose.yml` and `.env` (with a
new encryption key), asks for the web port and the address people will use,
starts Rackpath, and prints the first password for `admin`. You choose your
own password at the first sign-in.

### By hand

```bash
mkdir rackpath && cd rackpath
curl -fsSLO https://raw.githubusercontent.com/Stevy2191/Rackpath/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/Stevy2191/Rackpath/main/.env.example -o .env
sed -i "s/^RACKPATH_ENCRYPTION_KEY=.*/RACKPATH_ENCRYPTION_KEY=$(openssl rand -hex 32)/" .env
docker compose up -d
docker compose logs rackpath | grep password
```

Or without Compose:

```bash
docker run -d --name rackpath -p 8080:8080 -v rackpath-data:/data \
  -e RACKPATH_ENCRYPTION_KEY=$(openssl rand -hex 32) ghcr.io/stevy2191/rackpath:latest
```

To build the image yourself: `docker build -t rackpath .` from this folder.

### Settings

| Setting | Default | |
|---|---|---|
| `RACKPATH_ENCRYPTION_KEY` | required | 64 hex characters (`openssl rand -hex 32`). Encrypts stored integration secrets. **Back it up with your data.** |
| `RACKPATH_PORT` | `8080` | Host port (Compose) |
| `RACKPATH_PUBLIC_URL` | the request's address | The address people use, for invitation links and report QR codes |
| `RACKPATH_COOKIE_SECURE` | `false` | `true` when Rackpath is reached over HTTPS |
| `RACKPATH_TRUST_PROXY` | `false` | `true` behind a reverse proxy that sets `X-Forwarded-For` |
| `RACKPATH_AUDIT_RETENTION_DAYS` | keep forever | Delete change history older than this |

All settings are in [api-rs/README.md](api-rs/README.md#settings-environment-variables).

### Backups

Everything is in the `rackpath-data` volume: the database file and uploaded
floor plans. For a consistent copy while Rackpath runs:

```bash
docker compose exec rackpath rackpath backup /data/rackpath-backup.db
```

Keep `.env` (the encryption key) with your backups.

### Upgrading

```bash
docker compose pull && docker compose up -d
```

Database changes are applied automatically at start.

### Coming from Rackpath v1

Version 2 replaces the Node API, the nginx frontend and MariaDB with a single
container. Your v1 data can be brought across into a fresh v2:

```bash
# v1 must be at its latest version (so its database is fully migrated).
docker compose exec rackpath rackpath import-v1 --from "mysql://rackpath:PASSWORD@v1-db-host:3306/rackpath" --dry-run
docker compose exec rackpath rackpath import-v1 --from "mysql://rackpath:PASSWORD@v1-db-host:3306/rackpath"
```

Use the same `RACKPATH_ENCRYPTION_KEY` as v1 so integration secrets stay
readable. v1 users keep their passwords. What maps to what is described in
[api-rs/README.md](api-rs/README.md#bringing-v1-data-across).

## 🔒 Security

- **Nothing probes your network**, and no device logins are stored. The only
  secrets are the integration keys you give it, encrypted with AES-256-GCM
  and never sent back to the browser.
- **Passwords** are hashed with argon2id. Sign-in attempts are rate limited;
  two-factor sign-in (TOTP, with recovery codes) can be required for everyone.
- **Permissions** are checked on the server for every request; what you can't
  see answers 404.
- **The Windows DHCP push** uses its own token per integration, stored hashed
  and shown once.
- Details: [api-rs/README.md](api-rs/README.md#security-model-phase-1).

## 🛠️ Development

```
Rackpath/
├── api-rs/   # The server: Rust (axum, SQLite), API, migrations, tests
├── web/      # The web app: React + TypeScript (Vite), browser tests
├── tools/    # Windows DHCP/DNS push script
├── docs/     # Design notes and screenshots
└── Dockerfile, docker-compose.yml, deploy.sh
```

- Server: see [api-rs/README.md](api-rs/README.md). `cargo test`,
  `cargo clippy --all-targets -- -D warnings`, `cargo fmt`, `cargo audit`.
- Web app: see [web/README.md](web/README.md). `npm run dev` proxies the API
  to a local server; `node e2e/run.mjs` runs the browser tests against a
  release build.
- Database changes always ship with a new numbered migration in
  `api-rs/migrations/` (see `CLAUDE.md`).

CI runs both test suites on every push, and `docker-publish.yml` publishes
`ghcr.io/stevy2191/rackpath` from `main`.

## 📄 License

Rackpath is licensed under the [MIT License](LICENSE).
