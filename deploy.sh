#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Rackpath install script.
#
# Downloads the compose file, writes .env with a fresh encryption key, starts
# the one Rackpath container, and prints the owner's first password. Safe to
# re-run: an existing .env (and its key) is kept.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Stevy2191/Rackpath/main/deploy.sh | bash
#
# Environment overrides:
#   RACKPATH_DEPLOY_DIR      - directory to install into (default: ./rackpath)
#   RACKPATH_REPO_RAW_BASE   - base URL to fetch config files from
#   RACKPATH_PORT            - web port (asked for otherwise; default 8080)
#   RACKPATH_PUBLIC_URL      - the address people will use (asked for otherwise)
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

log "Downloading the compose file"
curl -fsSL "$REPO_RAW_BASE/docker-compose.yml" -o docker-compose.yml || die "Couldn't download docker-compose.yml"
curl -fsSL "$REPO_RAW_BASE/.env.example" -o .env.example || die "Couldn't download .env.example"
# The compose file can build from source; an install only pulls the image.
sed -i.bak '/^    build:/,/^      context: \./d' docker-compose.yml && rm -f docker-compose.yml.bak

if [ ! -f .env ]; then
  cp .env.example .env
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
echo
echo "  Back up:   the rackpath-data volume and .env (it holds the encryption key)"
echo "             docker compose exec rackpath rackpath backup /data/backup.db"
