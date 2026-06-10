#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Rackpath fresh-install deploy script.
#
# Downloads the compose config, sets up secrets, starts the stack, and
# creates the default admin user. Safe to re-run.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Stevy2191/Rackpath/main/deploy.sh | bash
#
# Environment overrides:
#   RACKPATH_DEPLOY_DIR      - directory to install into (default: ./rackpath)
#   RACKPATH_REPO_RAW_BASE   - base URL to fetch config files from
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_RAW_BASE="${RACKPATH_REPO_RAW_BASE:-https://raw.githubusercontent.com/Stevy2191/Rackpath/main}"
DEPLOY_DIR="${RACKPATH_DEPLOY_DIR:-rackpath}"
REQUIRED_PORTS=(8080 3010 5001 3306)
DB_HEALTH_TIMEOUT=120

log()  { printf '\n==> %s\n' "$1"; }
warn() { printf '\nWARNING: %s\n' "$1" >&2; }
die()  { printf '\nERROR: %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -Htln 2>/dev/null | awk '{print $4}' | grep -qE "[.:]${port}\$"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"${port}" -sTCP:LISTEN -P -n >/dev/null 2>&1
  elif command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "${port}" >/dev/null 2>&1
  else
    return 1
  fi
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# Read a value from the controlling terminal even when stdin is a pipe
# (e.g. `curl ... | bash`). Falls back to empty if no tty is available.
prompt() {
  local message="$1"
  local value=""
  if [ -r /dev/tty ]; then
    read -r -p "$message" value </dev/tty || true
  fi
  printf '%s' "$value"
}

# Escape a value for safe use as the replacement in `sed s/.../<value>/`.
escape_sed_repl() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//&/\\&}"
  s="${s//\//\\/}"
  printf '%s' "$s"
}

wait_for_healthy() {
  local container="$1"
  local timeout="$2"
  local elapsed=0
  local status

  while true; do
    status=$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo "starting")
    if [ "$status" = "healthy" ]; then
      return 0
    fi
    if [ "$elapsed" -ge "$timeout" ]; then
      return 1
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

command -v docker >/dev/null 2>&1 || die "Docker is required but was not found. Install it from https://docs.docker.com/engine/install/"
command -v curl >/dev/null 2>&1 || die "curl is required but was not found."

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  die "Docker Compose is required but was not found. Install the Docker Compose plugin."
fi

# ---------------------------------------------------------------------------
# Fetch deployment files
# ---------------------------------------------------------------------------

log "Setting up deployment directory: $DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR/db"
curl -fsSL "$REPO_RAW_BASE/docker-compose.yml" -o "$DEPLOY_DIR/docker-compose.yml"
curl -fsSL "$REPO_RAW_BASE/.env.example" -o "$DEPLOY_DIR/.env.example"
curl -fsSL "$REPO_RAW_BASE/db/init.sql" -o "$DEPLOY_DIR/db/init.sql"
cd "$DEPLOY_DIR"

# ---------------------------------------------------------------------------
# Port conflict check
# ---------------------------------------------------------------------------

log "Checking for port conflicts"
for port in "${REQUIRED_PORTS[@]}"; do
  if port_in_use "$port"; then
    warn "Port $port is already in use. Rackpath uses this port by default - either free it before continuing, or edit .env afterwards to use a different port and re-run 'docker compose up -d'."
  fi
done

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

log "Configuring secrets"

jwt_secret=$(prompt "Enter a JWT signing secret (leave blank to auto-generate a random one): ")
if [ -z "$jwt_secret" ]; then
  jwt_secret=$(generate_secret)
  echo "Generated a random JWT secret."
fi

admin_password=$(prompt "Enter a password for the default 'admin' user (leave blank to use 'rackpath'): ")
if [ -z "$admin_password" ]; then
  admin_password="rackpath"
  warn "Using the default admin password 'rackpath'. You will be required to change it on first login."
fi

# ---------------------------------------------------------------------------
# Write .env
# ---------------------------------------------------------------------------

log "Writing .env"
cp .env.example .env
sed -i "s/^RACKPATH_JWT_SECRET=.*/RACKPATH_JWT_SECRET=$(escape_sed_repl "$jwt_secret")/" .env
sed -i "s/^RACKPATH_ADMIN_PASSWORD=.*/RACKPATH_ADMIN_PASSWORD=$(escape_sed_repl "$admin_password")/" .env

# ---------------------------------------------------------------------------
# Start the stack
# ---------------------------------------------------------------------------

log "Pulling images and starting containers"
"${COMPOSE[@]}" up -d

log "Waiting for the database to become healthy"
if ! wait_for_healthy rackpath-db "$DB_HEALTH_TIMEOUT"; then
  die "rackpath-db did not become healthy within ${DB_HEALTH_TIMEOUT}s. Check 'docker compose logs rackpath-db'."
fi

log "Applying database schema"
"${COMPOSE[@]}" exec -T rackpath-db sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' < db/init.sql

log "Creating default admin user"
"${COMPOSE[@]}" exec -T rackpath-api npm run seed

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

frontend_port=$(grep -E '^FRONTEND_PORT=' .env | cut -d= -f2)

cat <<EOF

==========================================================================
 Rackpath is up!

 URL:      http://localhost:${frontend_port:-8080}
 Username: admin
 Password: ${admin_password}

 You will be required to change this password on first login.

 Configuration file: $(pwd)/.env
 Edit this file for future config changes, then run:
   cd $(pwd) && ${COMPOSE[*]} up -d
==========================================================================
EOF
