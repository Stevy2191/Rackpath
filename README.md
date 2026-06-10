# Rackpath

Self-hosted network topology and rack management web app.

## Stack

- **Frontend**: React + React Flow (topology diagram) + custom rack builder UI, served via nginx
- **API**: Node.js + Express + MariaDB (`mysql2` driver)
- **Scanner**: Python service using `nmap`, `pysnmp`, and `scapy` for network discovery (LLDP/CDP via SNMP OIDs)
- **Database**: MariaDB

## Project layout

```
Rackpath/
├── frontend/   # React app (React Flow topology, rack builder, device & scan pages)
├── api/        # Express API + MariaDB access layer
├── scanner/    # Python discovery service (nmap/snmp/lldp/arp), exposes a REST API
├── db/         # MariaDB schema init scripts
└── .github/    # CI workflows (build & publish images to GHCR)
```

## Getting started

1. Copy the environment template and adjust as needed:

   ```bash
   cp .env.example .env
   ```

2. Start the stack (pulls pre-built images from GHCR by default):

   ```bash
   docker compose up -d
   ```

3. Open the frontend at `http://localhost:8080` (or `FRONTEND_PORT` from `.env`).

### Building locally instead of pulling

To build all images from source instead of pulling from GHCR:

```bash
docker compose build
docker compose up -d
```

## Services

| Service              | Description                                              | Port (default) |
|----------------------|-----------------------------------------------------------|-----------------|
| `rackpath-frontend`  | React UI served via nginx                                 | 8080            |
| `rackpath-api`       | Express API backed by MariaDB                             | 3000            |
| `rackpath-scanner`   | Python discovery service (host networking)                | 8000            |
| `rackpath-db`        | MariaDB with persistent named volume                       | 3306            |

## Pages

- `/topology` — React Flow canvas of discovered devices and links
- `/racks` — Rack builder: create racks and place devices into U slots
- `/devices` — Device list with per-port editor (cabling/connections)
- `/scan` — Trigger discovery scans and view job progress/results

## Scanner capabilities

- Ping sweep over a CIDR subnet
- Nmap SYN scan (`-sS`) with OS detection
- SNMP v2c walk for interfaces, ARP table, and system info
- LLDP/CDP neighbor discovery via SNMP OIDs
- ARP table read (IP → MAC mapping)

Results are returned as structured JSON which the API persists to MariaDB.

## CI/CD

`.github/workflows/docker-publish.yml` builds and pushes the frontend, API,
and scanner images to GHCR (`ghcr.io/stevy2191/rackpath-*`) on every push to
`main`.
# Rackpath
