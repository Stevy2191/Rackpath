#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Rackpath install script.
#
# Downloads the compose file, writes .env with a fresh encryption key, asks
# how people will reach Rackpath (HTTPS with Caddy and a self-signed
# certificate, HTTPS through your own reverse proxy, or plain HTTP for
# testing), starts Rackpath, and prints the owner's first password. Safe to
# re-run: an existing .env (and its key) is kept.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Stevy2191/Rackpath/main/deploy.sh | bash
#
# Environment overrides:
#   RACKPATH_DEPLOY_DIR      - directory to install into (default: ./rackpath)
#   RACKPATH_REPO_RAW_BASE   - base URL to fetch config files from
#   RACKPATH_HTTPS_MODE      - caddy | proxy | http (asked for otherwise)
#   RACKPATH_PORT            - Rackpath's port (asked for otherwise; default 8080)
#   RACKPATH_PUBLIC_URL      - the address people will use (proxy or http mode)
#   RACKPATH_HOSTNAME        - name or IP for Caddy's certificate (caddy mode)
#   RACKPATH_HTTPS_PORT, RACKPATH_HTTP_PORT - Caddy's ports (443, 80)
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

host_ip=$(hostname -I 2>/dev/null | awk '{print $1}')

# Asks for a port. $1: question, $2: default, $3: a port this install
# already uses (not reported as taken).
ask_port() {
  local p="$2" answer
  if have_tty; then
    while true; do
      answer=$(prompt "  $1 [$p]: ")
      answer="${answer:-$p}"
      if ! valid_port "$answer"; then
        echo "  '$answer' is not a port number (1-65535)." >&2
        continue
      fi
      if port_in_use "$answer" && [ "$answer" != "${3:-}" ]; then
        [[ "$(prompt "  Port $answer is in use. Use it anyway? [y/N]: ")" =~ ^[Yy] ]] || continue
      fi
      p="$answer"
      break
    done
  fi
  valid_port "$p" || die "Invalid port for '$1': $p"
  printf '%s' "$p"
}

# How people reach Rackpath. Asked every run, defaulting to the last choice.
mode="${RACKPATH_HTTPS_MODE:-$(env_value RACKPATH_HTTPS_MODE)}"
if [ -z "$mode" ]; then
  case "$(env_value RACKPATH_PUBLIC_URL)" in https://*) mode=proxy ;; *) mode=http ;; esac
fi
if [ -z "${RACKPATH_HTTPS_MODE:-}" ] && have_tty; then
  case "$mode" in caddy) choice=1 ;; proxy) choice=2 ;; *) choice=3 ;; esac
  echo
  echo "  How will people reach Rackpath?"
  echo "    1) HTTPS with Caddy and a self-signed certificate (set up here)"
  echo "    2) HTTPS through your own reverse proxy (Nginx Proxy Manager, Traefik, ...)"
  echo "    3) Plain HTTP, for testing only"
  while true; do
    answer=$(prompt "  Choose 1, 2 or 3 [${choice}]: ")
    case "${answer:-$choice}" in
      1) mode=caddy; break ;;
      2) mode=proxy; break ;;
      3) mode=http; break ;;
      *) echo "  Please answer 1, 2 or 3." >&2 ;;
    esac
  done
fi
case "$mode" in caddy|proxy|http) ;; *) die "RACKPATH_HTTPS_MODE must be caddy, proxy or http (got '$mode')" ;; esac
set_env_value RACKPATH_HTTPS_MODE "$mode"

current_port=$(env_value RACKPATH_PORT)
port="${RACKPATH_PORT:-${current_port:-$DEFAULT_PORT}}"
public_url="${RACKPATH_PUBLIC_URL:-$(env_value RACKPATH_PUBLIC_URL)}"

case "$mode" in
  caddy)
    hostname="${RACKPATH_HOSTNAME:-$(env_value RACKPATH_HOSTNAME)}"
    hostname="${hostname:-${host_ip:-localhost}}"
    if [ -z "${RACKPATH_HOSTNAME:-}" ] && have_tty; then
      answer=$(prompt "  Name or IP address people will type (the certificate is made for it) [${hostname}]: ")
      hostname="${answer:-$hostname}"
    fi
    case "$hostname" in *[!A-Za-z0-9.:-]*|'') die "Not a host name or IP address: '$hostname'" ;; esac
    current_https=$(env_value RACKPATH_HTTPS_PORT)
    current_http=$(env_value RACKPATH_HTTP_PORT)
    https_port="${RACKPATH_HTTPS_PORT:-${current_https:-443}}"
    http_port="${RACKPATH_HTTP_PORT:-${current_http:-80}}"
    [ -n "${RACKPATH_HTTPS_PORT:-}" ] || https_port=$(ask_port "HTTPS port" "$https_port" "$current_https")
    [ -n "${RACKPATH_HTTP_PORT:-}" ] || http_port=$(ask_port "HTTP port (redirects to HTTPS)" "$http_port" "$current_http")
    [ -n "${RACKPATH_PORT:-}" ] || port=$(ask_port "Port for Rackpath itself (only reachable from this machine)" "$port" "$current_port")
    [ "$https_port" != "$http_port" ] && [ "$https_port" != "$port" ] && [ "$http_port" != "$port" ] ||
      die "The HTTPS, HTTP and Rackpath ports must all differ ($https_port, $http_port, $port)."
    public_url="https://${hostname}"
    [ "$https_port" = 443 ] || public_url="${public_url}:${https_port}"
    set_env_value COMPOSE_PROFILES caddy
    set_env_value RACKPATH_BIND_ADDRESS 127.0.0.1
    set_env_value RACKPATH_HOSTNAME "$hostname"
    set_env_value RACKPATH_HTTPS_PORT "$https_port"
    set_env_value RACKPATH_HTTP_PORT "$http_port"
    set_env_value RACKPATH_COOKIE_SECURE true
    # Caddy sets X-Forwarded-For itself, and Rackpath is only published on
    # 127.0.0.1, so the header can be trusted.
    set_env_value RACKPATH_TRUST_PROXY true
    ;;
  proxy)
    [ -n "${RACKPATH_PORT:-}" ] || port=$(ask_port "Port your proxy will forward to" "$port" "$current_port")
    if [ -z "${RACKPATH_PUBLIC_URL:-}" ] && have_tty; then
      while true; do
        answer=$(prompt "  Address people will use, e.g. https://rackpath.example.com [${public_url:-none}]: ")
        answer="${answer:-$public_url}"
        case "$answer" in
          https://*) public_url="${answer%/}"; break ;;
          http://*) [[ "$(prompt "  That's not HTTPS. Use it anyway? [y/N]: ")" =~ ^[Yy] ]] && { public_url="${answer%/}"; break; } ;;
          *) echo "  Enter the full address, starting with https://" >&2 ;;
        esac
      done
    fi
    set_env_value COMPOSE_PROFILES ""
    set_env_value RACKPATH_BIND_ADDRESS 0.0.0.0
    case "$public_url" in
      https://*) set_env_value RACKPATH_COOKIE_SECURE true ;;
      *) set_env_value RACKPATH_COOKIE_SECURE false ;;
    esac
    set_env_value RACKPATH_TRUST_PROXY true
    ;;
  http)
    [ -n "${RACKPATH_PORT:-}" ] || port=$(ask_port "Web port" "$port" "$current_port")
    case "$public_url" in https://*) public_url="" ;; esac
    if [ -z "${RACKPATH_PUBLIC_URL:-}" ] && have_tty; then
      answer=$(prompt "  Address people will use, e.g. http://${host_ip:-server}:${port} [${public_url:-the address each request arrives at}]: ")
      public_url="${answer:-$public_url}"
    fi
    set_env_value COMPOSE_PROFILES ""
    set_env_value RACKPATH_BIND_ADDRESS 0.0.0.0
    set_env_value RACKPATH_COOKIE_SECURE false
    set_env_value RACKPATH_TRUST_PROXY false
    ;;
esac
set_env_value RACKPATH_PORT "$port"
set_env_value RACKPATH_PUBLIC_URL "$public_url"
chmod 600 .env

log "Starting Rackpath"
docker compose pull || die "Couldn't pull the image"
docker compose up -d || die "Couldn't start the container"
if [ "$mode" != caddy ]; then
  # Caddy from an earlier choice: stop and remove it (its certificates stay).
  docker compose --profile caddy rm -sf caddy >/dev/null 2>&1 || true
fi

# The owner account is created on the first start; its temporary password
# is printed once in the log.
password=""
for _ in $(seq 1 30); do
  password=$(docker compose logs rackpath 2>/dev/null | sed -n 's/.*password: \([^ ]*\).*/\1/p' | tail -n 1)
  [ -n "$password" ] && break
  sleep 1
done

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
case "$mode" in
  caddy)
    echo "  HTTPS:     Caddy, with a certificate from its own certificate authority. Browsers"
    echo "             warn until they trust that authority. Its root certificate:"
    echo "               docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt rackpath-ca.crt"
    echo "             Install rackpath-ca.crt as a trusted root on the computers that use Rackpath"
    echo "             (or through Group Policy), or accept the browser's warning."
    ;;
  proxy)
    echo "  Proxy:     point your reverse proxy (Nginx Proxy Manager etc.) at"
    echo "               http://${host_ip:-this-server}:${port}"
    echo "             and let it handle HTTPS for ${public_url:-your address}. Rackpath trusts the"
    echo "             X-Forwarded-For header it sends, so keep port ${port} reachable only from"
    echo "             the proxy (a firewall rule), not from users directly."
    ;;
  http)
    echo "  HTTP only: passwords and data travel unencrypted. Fine for testing; for real use,"
    echo "             run this script again and choose HTTPS."
    ;;
esac
echo
echo "  Back up:   the rackpath-data volume and .env (it holds the encryption key)"
echo "             docker compose exec rackpath rackpath backup /data/backup.db"
