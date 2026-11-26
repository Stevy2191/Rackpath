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
#
# Ports are asked for interactively. To install without a terminal (or to
# script it), set any of these and the matching question is skipped:
#   RACKPATH_FRONTEND_PORT   - web UI            (default: 8080)
#   RACKPATH_API_PORT        - API               (default: 3010)
#   RACKPATH_SCANNER_PORT    - scanner service   (default: 5001)
#   RACKPATH_DB_PORT         - MariaDB           (default: 3306)
# ---------------------------------------------------------------------------
set -uo pipefail

REPO_RAW_BASE="${RACKPATH_REPO_RAW_BASE:-https://raw.githubusercontent.com/Stevy2191/Rackpath/main}"
DEPLOY_DIR="${RACKPATH_DEPLOY_DIR:-rackpath}"
DB_HEALTH_TIMEOUT=120

DEFAULT_FRONTEND_PORT=8080
DEFAULT_API_PORT=3010
DEFAULT_SCANNER_PORT=5001
DEFAULT_DB_PORT=3306

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
  if have_tty; then
    read -r -p "$message" value </dev/tty || true
  fi
  printf '%s' "$value"
}

# True when there is a terminal to ask questions on. `curl | bash` has no
# controlling terminal, in which case every prompt takes its default instead
# of hanging. Tests the open rather than the permission bits: /dev/tty exists
# and looks readable even when opening it fails with ENXIO.
have_tty() { { true </dev/tty; } 2>/dev/null; }

valid_port() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# Reads a port from the user, falling back to $default. Re-asks on anything
# that isn't a port number, and on a port that's already listening - the
# whole point of asking is to route around a conflict, but the user can still
# insist, since the thing holding the port may be a previous Rackpath.
#
#   $1 label   $2 default   $3 preset (from env; skips the prompt)
prompt_port() {
  local label="$1" default="$2" preset="${3:-}" value

  if [ -n "$preset" ]; then
    if valid_port "$preset"; then
      printf '%s' "$preset"
      return 0
    fi
    warn "Ignoring invalid ${label} port '${preset}' - using ${default}."
    printf '%s' "$default"
    return 0
  fi

  if ! have_tty; then
    printf '%s' "$default"
    return 0
  fi

  while true; do
    value=$(prompt "  ${label} port [${default}]: ")
    [ -z "$value" ] && value="$default"

    if ! valid_port "$value"; then
      echo "  '$value' is not a port number (1-65535). Try again." >&2
      continue
    fi

    if port_in_use "$value"; then
      local answer
      answer=$(prompt "  Port $value is already in use. Use it anyway? [y/N]: ")
      case "$answer" in
        [Yy]*) ;;
        *) continue ;;
      esac
    fi

    printf '%s' "$value"
    return 0
  done
}

# Reads KEY=value out of an existing .env so a re-run can offer what's
# already deployed as the default rather than silently resetting it.
env_value() {
  local key="$1"
  [ -f .env ] || return 0
  sed -n "s/^${key}=//p" .env | head -n 1
}

# Sets KEY=value in .env, replacing the existing line or appending it.
set_env_value() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    sed -i "s/^${key}=.*/${key}=$(escape_sed_repl "$value")/" .env \
      || die "Failed to write ${key} into .env"
  else
    printf '%s=%s\n' "$key" "$value" >> .env || die "Failed to append ${key} to .env"
  fi
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
mkdir -p "$DEPLOY_DIR/db" || die "Failed to create deployment directory: $DEPLOY_DIR/db"
curl -fsSL "$REPO_RAW_BASE/docker-compose.yml" -o "$DEPLOY_DIR/docker-compose.yml" || die "Failed to download docker-compose.yml from $REPO_RAW_BASE"
curl -fsSL "$REPO_RAW_BASE/.env.example" -o "$DEPLOY_DIR/.env.example" || die "Failed to download .env.example from $REPO_RAW_BASE"
curl -fsSL "$REPO_RAW_BASE/db/init.sql" -o "$DEPLOY_DIR/db/init.sql" || die "Failed to download db/init.sql from $REPO_RAW_BASE"
cd "$DEPLOY_DIR" || die "Failed to cd into deployment directory: $DEPLOY_DIR"

# ---------------------------------------------------------------------------
# Ports
#
# Every port here is on the host. The ports used inside the compose network
# are fixed, because the frontend image bakes in an nginx config that proxies
# /api/ to rackpath-api:3010.
# ---------------------------------------------------------------------------

log "Choosing ports"
if have_tty && [ -z "${RACKPATH_FRONTEND_PORT:-}${RACKPATH_API_PORT:-}${RACKPATH_SCANNER_PORT:-}${RACKPATH_DB_PORT:-}" ]; then
  echo "Press Enter to accept the default for each."
  echo ""
fi

# A re-run offers whatever is already deployed; a fresh install offers the
# documented default.
default_for() {
  local current
  current=$(env_value "$1")
  if valid_port "$current"; then printf '%s' "$current"; else printf '%s' "$2"; fi
}

frontend_port=$(prompt_port "Web UI"   "$(default_for FRONTEND_PORT "$DEFAULT_FRONTEND_PORT")" "${RACKPATH_FRONTEND_PORT:-}")
api_port=$(prompt_port      "API"      "$(default_for API_PORT      "$DEFAULT_API_PORT")"      "${RACKPATH_API_PORT:-}")
scanner_port=$(prompt_port  "Scanner"  "$(default_for SCANNER_PORT  "$DEFAULT_SCANNER_PORT")"  "${RACKPATH_SCANNER_PORT:-}")
db_port=$(prompt_port       "Database" "$(default_for DB_PORT       "$DEFAULT_DB_PORT")"       "${RACKPATH_DB_PORT:-}")

for pair in "Web UI:$frontend_port" "API:$api_port" "Scanner:$scanner_port" "Database:$db_port"; do
  for other in "Web UI:$frontend_port" "API:$api_port" "Scanner:$scanner_port" "Database:$db_port"; do
    if [ "${pair%%:*}" != "${other%%:*}" ] && [ "${pair##*:}" = "${other##*:}" ]; then
      die "${pair%%:*} and ${other%%:*} are both set to port ${pair##*:}. Each service needs its own port."
    fi
  done
done

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

log "Configuring secrets"

existing_secret=$(env_value RACKPATH_JWT_SECRET)
if [ -n "$existing_secret" ] && [ "$existing_secret" != "changeme_use_a_long_random_string" ]; then
  jwt_secret=$(prompt "Enter a JWT signing secret (leave blank to keep the existing one): ")
  if [ -z "$jwt_secret" ]; then
    jwt_secret="$existing_secret"
    echo "Keeping the existing JWT secret - current logins stay valid."
  fi
else
  jwt_secret=$(prompt "Enter a JWT signing secret (leave blank to auto-generate a random one): ")
  if [ -z "$jwt_secret" ]; then
    jwt_secret=$(generate_secret)
    echo "Generated a random JWT secret."
  fi
fi

# ---------------------------------------------------------------------------
# Write .env
#
# An existing .env is updated in place rather than replaced, so a re-run
# doesn't discard passwords or anything else hand-edited.
# ---------------------------------------------------------------------------

fresh_env=false
if [ -f .env ]; then
  log "Updating .env"
else
  log "Writing .env"
  # Created owner-only before any secret goes into it.
  (umask 077 && cp .env.example .env) || die "Failed to create .env from .env.example"
  fresh_env=true
fi
chmod 600 .env 2>/dev/null || warn "Could not restrict .env permissions to owner-only (chmod 600)."

# Database passwords: a fresh install gets random ones instead of the
# changeme_* placeholders. An existing install keeps its values, because
# MariaDB only reads them when the data volume is first created, so changing
# them here would lock the API out of its own database.
if [ "$fresh_env" = true ]; then
  db_app_password=$(generate_secret)
  set_env_value MYSQL_ROOT_PASSWORD "$(generate_secret)"
  set_env_value MYSQL_PASSWORD "$db_app_password"
  set_env_value DB_PASSWORD "$db_app_password"
  echo "Generated random database passwords."
elif env_value MYSQL_ROOT_PASSWORD | grep -q '^changeme' || env_value MYSQL_PASSWORD | grep -q '^changeme'; then
  warn "Your .env still uses the default changeme_* database passwords. The database is only published on 127.0.0.1, but you should change them (see README: Changing the database passwords)."
fi

# Shared secret between the API and the scanner. Generated once and kept.
if [ -z "$(env_value SCANNER_TOKEN)" ]; then
  set_env_value SCANNER_TOKEN "$(generate_secret)"
  echo "Generated a scanner token."
fi

set_env_value RACKPATH_JWT_SECRET "$jwt_secret"
set_env_value FRONTEND_PORT "$frontend_port"
set_env_value API_PORT "$api_port"
set_env_value SCANNER_PORT "$scanner_port"
set_env_value DB_PORT "$db_port"
# Both are addresses the services use to reach each other across the host
# network, so they have to carry the ports chosen above.
set_env_value API_PUBLIC_URL "http://localhost:${api_port}"
set_env_value SCANNER_URL "http://host.docker.internal:${scanner_port}"

# ---------------------------------------------------------------------------
# Start the stack
# ---------------------------------------------------------------------------

log "Pulling images and starting containers"
"${COMPOSE[@]}" pull || die "Failed to pull images. Check your network connection and try again."
"${COMPOSE[@]}" up -d || die "Failed to start containers. Check 'docker compose logs' for details."

log "Waiting for the database to become healthy"
if ! wait_for_healthy rackpath-db "$DB_HEALTH_TIMEOUT"; then
  die "rackpath-db did not become healthy within ${DB_HEALTH_TIMEOUT}s. Check 'docker compose logs rackpath-db'."
fi

log "Applying database schema"
if ! "${COMPOSE[@]}" exec -T rackpath-db sh -c 'exec mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' < db/init.sql; then
  die "Failed to apply database schema. Check 'docker compose logs rackpath-db'."
fi

log "Creating default admin user"
if ! "${COMPOSE[@]}" exec -T rackpath-api npm run seed < /dev/null; then
  warn "Seeding the default admin user failed. You can re-run it manually with: cd $(pwd) && ${COMPOSE[*]} exec -T rackpath-api npm run seed"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

host_ip=$(hostname -I 2>/dev/null | awk '{print $1}') || host_ip="localhost"

echo "==> Deployment complete"
echo ""
echo "=========================================="
echo "  Rackpath is ready!"
echo "=========================================="
echo ""
echo "  URL:      http://${host_ip:-localhost}:${frontend_port}"
echo ""
echo "  Login with the default credentials:"
echo "  Username: admin"
echo "  Password: rackpath"
echo ""
echo "  You will be asked to change your password on first login."
echo ""
echo "  Ports:    web UI   ${frontend_port}"
echo "            API      ${api_port}"
echo "            scanner  ${scanner_port}"
echo "            database ${db_port}"
echo ""
echo "  To change a port later, edit .env and run 'docker compose up -d'."
echo ""
echo "  Config file: $(pwd)/.env"
echo "=========================================="
echo ""
