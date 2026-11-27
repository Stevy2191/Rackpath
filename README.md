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
new encryption key), asks how people will reach Rackpath (see
[HTTPS](#https)), starts Rackpath, and prints the first password for `admin`.
You choose your own password at the first sign-in. Run it again any time: it
keeps your `.env` and key, and lets you change your answers.

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

### From a clone of this repository

```bash
git clone https://github.com/Stevy2191/Rackpath.git && cd Rackpath
sudo ./update.sh
```

`update.sh` writes `.env` with a new encryption key the first time, builds
the image from the code and starts it (`--image` uses the published image
instead of building). Set the port and address in `.env` (see below).

### Settings

| Setting | Default | |
|---|---|---|
| `RACKPATH_ENCRYPTION_KEY` | required | 64 hex characters (`openssl rand -hex 32`). Encrypts stored integration secrets. **Back it up with your data.** |
| `RACKPATH_HTTPS_MODE` | `http` | `caddy`, `proxy` or `http` (see [HTTPS](#https)); `deploy.sh` sets the rest to match |
| `RACKPATH_PORT` | `8080` | Host port for Rackpath (Compose) |
| `RACKPATH_BIND_ADDRESS` | `0.0.0.0` | Where that port is published; `127.0.0.1` with Caddy |
| `COMPOSE_PROFILES` | empty | `caddy` runs the Caddy container |
| `RACKPATH_HOSTNAME` | | Caddy: the name or IP address its certificate is for |
| `RACKPATH_HTTPS_PORT`, `RACKPATH_HTTP_PORT` | `443`, `80` | Caddy's ports (HTTP redirects to HTTPS) |
| `RACKPATH_PUBLIC_URL` | the request's address | The address people use, for invitation links and report QR codes |
| `RACKPATH_COOKIE_SECURE` | `false` | `true` when Rackpath is reached over HTTPS |
| `RACKPATH_TRUST_PROXY` | `false` | `true` behind a reverse proxy that sets `X-Forwarded-For` |
| `RACKPATH_AUDIT_RETENTION_DAYS` | keep forever | Delete change history older than this |

All settings are in [api-rs/README.md](api-rs/README.md#settings-environment-variables).

### HTTPS

The install script asks which of these you want:

1. **Caddy with a self-signed certificate.** A Caddy container serves HTTPS
   on port 443 (HTTP on 80 redirects), with a certificate from Caddy's own
   certificate authority for the name or IP address you give. Rackpath itself
   is then published only on `127.0.0.1`. Browsers warn until they trust that
   authority; to stop the warnings, copy its root certificate out and install
   it as a trusted root on the computers that use Rackpath (or through Group
   Policy):

   ```bash
   docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt rackpath-ca.crt
   ```

2. **Your own reverse proxy** (Nginx Proxy Manager, Traefik, …). Point it at
   `http://<this server>:<RACKPATH_PORT>` and give it the certificate; the
   script asks for the HTTPS address people will use. Rackpath trusts the
   proxy's `X-Forwarded-For`, so let only the proxy reach that port (a
   firewall rule).

3. **Plain HTTP, for testing only.** Passwords travel unencrypted.

To change later, run `deploy.sh` again (or edit `.env` and
`docker compose up -d`).

### Backups

Everything is in the `rackpath-data` volume: the database file and uploaded
floor plans. For a consistent copy while Rackpath runs:

```bash
docker compose exec rackpath rackpath backup /data/rackpath-backup.db
```

Keep `.env` (the encryption key) with your backups.

### Updating

From a clone of this repository, as root:

```bash
sudo ./update.sh
```

It pulls the latest code (as the clone's owner, so git's ownership check is
happy), backs up the database, rebuilds, restarts and checks Rackpath answers
again. It stops without changing anything if you have local edits to the
code. Options: `--image` pulls the published image instead of building (much
quicker on a small server), `--no-backup`, `--no-pull`.

Installed with `deploy.sh` (no clone):

```bash
docker compose pull && docker compose up -d
```

Database changes are applied automatically at start.

### Data from Rackpath v1

Version 2 replaces v1's Node API, nginx frontend and MariaDB, and starts with
a fresh database. To bring data from a v1 database into a new, empty v2:

```bash
export RACKPATH_V1_JWT_SECRET=...   # v1's RACKPATH_JWT_SECRET, for integration secrets
docker compose exec -e RACKPATH_V1_JWT_SECRET rackpath rackpath import-v1 --from "mysql://rackpath:PASSWORD@v1-host:3306/rackpath" --dry-run
```

Leave out `--dry-run` to import. Details are in
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
└── Dockerfile, docker-compose.yml, deploy.sh, update.sh
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
