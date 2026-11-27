#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Rackpath install script.
#
# Downloads the compose file, writes .env with a fresh encryption key, starts
# the one Rackpath container, and prints the owner's first password. Safe to
# re-run: an existing .env (and its key) is kept.
#
# Run in a folder with a Rackpath v1 install (Node API, nginx, MariaDB), it
# upgrades it: keeps v1's files as docker-compose.v1.yml and .env.v1, stops
# v1's app containers but keeps its database running, starts v2 on v1's web
# port and imports v1's data (a dry run first). v1's database volume is never
# removed; see the end of the run for retiring it.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Stevy2191/Rackpath/main/deploy.sh | bash
#
# Environment overrides:
#   RACKPATH_DEPLOY_DIR      - directory to install into (default: ./rackpath)
#   RACKPATH_REPO_RAW_BASE   - base URL to fetch config files from
#   RACKPATH_PORT            - web port (asked for otherwise; default 8080)
#   RACKPATH_PUBLIC_URL      - the address people will use (asked for otherwise)
#   RACKPATH_UPGRADE_V1=yes  - upgrade a v1 install without asking (needed when
#                              there is no terminal to ask on)
# ---------------------------------------------------------------------------
set -uo pipefail

REPO_RAW_BASE="${RACKPATH_REPO_RAW_BASE:-https://raw.githubusercontent.com/Stevy2191/Rackpath/main}"
DEPLOY_DIR="${RACKPATH_DEPLOY_DIR:-rackpath}"
DEFAULT_PORT=8080

log()  { printf '\n==> %s\n' "$1"; }
warn() { printf '\nWARNING: %s\n' "$1" >&2; }
die()  { printf '\nERROR: %s\n' "$1" >&2; exit 1; }

# True when there is a terminal to ask questions on. `curl | bash` has no
# controlling terminal, in which case every prompt takes its default instead
# of hanging. Tests the open rather than the permission bits: /dev/tty exists
# and looks readable even when opening it fails with ENXIO.
have_tty() { { true </dev/tty; } 2>/dev/null; }

prompt() {
  local value=""
  if have_tty; then
    read -r -p "$1" value </dev/tty || true
  fi
  printf '%s' "$value"
}

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -Htln 2>/dev/null | awk '{print $4}' | grep -qE "[.:]${port}\$"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"${port}" -sTCP:LISTEN -P -n >/dev/null 2>&1
  else
    return 1
  fi
}

valid_port() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

generate_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

env_value() {
  [ -f .env ] || return 0
  sed -n "s/^$1=//p" .env | head -n 1
}

# Percent-encodes a value for a URL (the v1 database password).
urlencode() {
  local s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+=$(printf '%%%02X' "'$c") ;;
    esac
  done
  printf '%s' "$out"
}

# A v1 install: its compose file runs rackpath-api, or its .env has v1's
# database settings.
is_v1_install() {
  { [ -f docker-compose.yml ] && grep -q 'rackpath-api' docker-compose.yml; } ||
    { [ -f .env ] && grep -qE '^(DB_PASSWORD|RACKPATH_JWT_SECRET)=' .env; }
}

v1_value() { sed -n "s/^$1=//p" .env.v1 2>/dev/null | head -n 1; }

set_env_value() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    local tmp
    tmp=$(mktemp) && awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k"="v; next} {print}' .env >"$tmp" && mv "$tmp" .env
  else
    printf '%s=%s\n' "$key" "$value" >>.env
  fi
}

# ---------------------------------------------------------------------------

command -v docker >/dev/null 2>&1 || die "Docker is required: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (the 'docker compose' command)."

mkdir -p "$DEPLOY_DIR" && cd "$DEPLOY_DIR" || die "Can't use $DEPLOY_DIR"

upgrading=false
if is_v1_install; then
  log "Found a Rackpath v1 install in $(pwd)"
  echo "  Rackpath 2 replaces v1's API, web server and MariaDB with one container."
  echo "  v1's database is kept, and its data is copied into v2 (checked with a dry run first)."
  if [ "${RACKPATH_UPGRADE_V1:-}" != "yes" ]; then
    have_tty || die "Set RACKPATH_UPGRADE_V1=yes to upgrade this v1 install without a terminal, or choose another folder with RACKPATH_DEPLOY_DIR."
    [[ "$(prompt "  Upgrade it to v2? [y/N]: ")" =~ ^[Yy] ]] || die "Nothing changed. To install v2 alongside v1 instead, set RACKPATH_DEPLOY_DIR to another folder (and pick another port)."
  fi
  upgrading=true
  # Kept for reference and for going back; an earlier upgrade's copy wins.
  [ -f docker-compose.v1.yml ] || cp docker-compose.yml docker-compose.v1.yml
  [ -f .env.v1 ] || cp .env .env.v1
  chmod 600 .env.v1
  rm -f .env
elif [ -f .env.v1 ] && [ ! -f .v1-imported ]; then
  log "Carrying on with the upgrade from v1 (its data isn't imported yet)"
  upgrading=true
fi
if $upgrading; then
  log "Stopping v1's API, web and scanner containers (its database keeps running)"
  docker stop rackpath-frontend rackpath-api rackpath-scanner >/dev/null 2>&1 || true
  docker start rackpath-db >/dev/null 2>&1 || die "Couldn't start v1's database container (rackpath-db)."
fi

log "Downloading the compose file"
curl -fsSL "$REPO_RAW_BASE/docker-compose.yml" -o docker-compose.yml || die "Couldn't download docker-compose.yml"
curl -fsSL "$REPO_RAW_BASE/.env.example" -o .env.example || die "Couldn't download .env.example"
# The compose file can build from source; an install only pulls the image.
sed -i.bak '/^    build:/,/^      context: \./d' docker-compose.yml && rm -f docker-compose.yml.bak

if [ ! -f .env ]; then
  cp .env.example .env
  if $upgrading; then
    # v1 builds that encrypted their own secrets used the same key setting.
    v1_key=$(v1_value RACKPATH_ENCRYPTION_KEY)
    [ -n "$v1_key" ] && set_env_value RACKPATH_ENCRYPTION_KEY "$v1_key"
    # v1's web port, so people keep the same address.
    v1_port=$(v1_value FRONTEND_PORT)
    set_env_value RACKPATH_PORT "${v1_port:-$DEFAULT_PORT}"
  fi
fi

if [ -z "$(env_value RACKPATH_ENCRYPTION_KEY)" ]; then
  log "Creating an encryption key (kept in .env; back it up with your data)"
  set_env_value RACKPATH_ENCRYPTION_KEY "$(generate_key)"
fi

port="${RACKPATH_PORT:-$(env_value RACKPATH_PORT)}"
port="${port:-$DEFAULT_PORT}"
if [ -z "${RACKPATH_PORT:-}" ] && have_tty; then
  while true; do
    answer=$(prompt "  Web port [${port}]: ")
    answer="${answer:-$port}"
    if ! valid_port "$answer"; then
      echo "  '$answer' is not a port number (1-65535)." >&2
      continue
    fi
    if port_in_use "$answer" && [ "$answer" != "$(env_value RACKPATH_PORT)" ]; then
      [[ "$(prompt "  Port $answer is in use. Use it anyway? [y/N]: ")" =~ ^[Yy] ]] || continue
    fi
    port="$answer"
    break
  done
fi
valid_port "$port" || die "Invalid port: $port"
set_env_value RACKPATH_PORT "$port"

public_url="${RACKPATH_PUBLIC_URL:-$(env_value RACKPATH_PUBLIC_URL)}"
if [ -z "${RACKPATH_PUBLIC_URL:-}" ] && have_tty; then
  answer=$(prompt "  Address people will use, e.g. https://rackpath.example.com [${public_url:-leave empty}]: ")
  public_url="${answer:-$public_url}"
fi
set_env_value RACKPATH_PUBLIC_URL "$public_url"
case "$public_url" in https://*) set_env_value RACKPATH_COOKIE_SECURE true ;; esac
chmod 600 .env

log "Starting Rackpath"
docker compose pull || die "Couldn't pull the image"
docker compose up -d || die "Couldn't start the container"

# The owner account is created on the first start; its temporary password
# is printed once in the log.
password=""
for _ in $(seq 1 30); do
  password=$(docker compose logs rackpath 2>/dev/null | sed -n 's/.*password: \([^ ]*\).*/\1/p' | tail -n 1)
  [ -n "$password" ] && break
  sleep 1
done

if $upgrading; then
  db_user=$(v1_value DB_USER); db_user=${db_user:-$(v1_value MYSQL_USER)}; db_user=${db_user:-rackpath}
  db_pass=$(v1_value DB_PASSWORD); db_pass=${db_pass:-$(v1_value MYSQL_PASSWORD)}
  db_name=$(v1_value DB_NAME); db_name=${db_name:-$(v1_value MYSQL_DATABASE)}; db_name=${db_name:-rackpath}
  # Both run in this folder's compose project, so v2 reaches v1's database
  # by its name on the shared network.
  v1_url="mysql://$(urlencode "$db_user"):$(urlencode "$db_pass")@rackpath-db:3306/$(urlencode "$db_name")"
  import_v1() {
    # The JWT secret goes in through the environment, not the command line.
    RACKPATH_V1_JWT_SECRET="$(v1_value RACKPATH_JWT_SECRET)" docker compose exec -T \
      -e RACKPATH_V1_JWT_SECRET rackpath rackpath import-v1 --from "$v1_url" "$@"
  }
  import_help() {
    echo "  To import later (into a v2 that has no projects yet):"
    echo "    RACKPATH_V1_JWT_SECRET=<RACKPATH_JWT_SECRET from .env.v1> docker compose exec -e RACKPATH_V1_JWT_SECRET \\"
    echo "      rackpath rackpath import-v1 --from 'mysql://<DB_USER>:<DB_PASSWORD>@rackpath-db:3306/<DB_NAME>' [--dry-run]"
  }
  for _ in $(seq 1 30); do
    docker exec rackpath-db sh -c 'mariadb-admin ping -h 127.0.0.1 --silent || mysqladmin ping -h 127.0.0.1 --silent' >/dev/null 2>&1 && break
    sleep 2
  done
  log "Checking v1's data (dry run: nothing is saved)"
  if ! import_v1 --dry-run; then
    warn "The dry run failed (above), so nothing was imported; v2 is running, empty."
    echo "  If it says v1 is too old, run the latest v1 once so its database migrates, then"
    echo "  run this script again:"
    echo "    docker compose stop rackpath"
    echo "    docker compose --env-file .env.v1 -f docker-compose.v1.yml pull"
    echo "    docker compose --env-file .env.v1 -f docker-compose.v1.yml up -d"
    import_help
  elif have_tty && [[ "$(prompt "  Import this into v2 now? [Y/n]: ")" =~ ^[Nn] ]]; then
    echo "  Not imported. Run this script again to import, or:"
    import_help
  else
    log "Importing v1's data"
    if import_v1; then
      touch .v1-imported
    else
      warn "The import failed (above)."
      import_help
    fi
  fi
fi

host_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
log "Rackpath is running"
echo "  Open:      ${public_url:-http://${host_ip:-localhost}:${port}}"
if [ -n "$password" ]; then
  echo "  Sign in:   admin / ${password}"
  echo "  You'll choose your own password at the first sign-in."
else
  echo "  Sign in as admin. If this isn't the first install, use your existing password;"
  echo "  lost it? docker compose exec rackpath rackpath reset-password admin"
fi
if $upgrading; then
  echo "  v1 users sign in with their v1 passwords. v1's admin is v2's owner account:"
  echo "  sign in as admin with the password above, or your own if you've set it."
fi
echo
echo "  Back up:   the rackpath-data volume and .env (it holds the encryption key)"
echo "             docker compose exec rackpath rackpath backup /data/backup.db"
if $upgrading; then
  echo
  echo "  v1's database is still running and its data is untouched. Once you're happy"
  echo "  with v2, remove v1's containers (its volumes stay until you delete them):"
  echo "             docker compose up -d --remove-orphans"
fi
