#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Rackpath update script. Run as root from a clone of the repository:
#
#   sudo ./update.sh            # pull the latest code, build it, restart
#   sudo ./update.sh --image    # pull the published image instead of building
#
# It:
#   1. pulls the latest code (as the checkout's owner, never as root, so git's
#      ownership check is happy and no root-owned files land in the checkout);
#   2. backs up the database (a new version can migrate it);
#   3. builds the image from the code (or pulls the published one) and
#      restarts the container;
#   4. waits until Rackpath answers again.
#
# Your settings in .env and the data in the rackpath-data volume are kept.
# The first run in a fresh clone writes .env with a new encryption key.
#
# Options:
#   --image       use ghcr.io/stevy2191/rackpath instead of building (faster;
#                 the published image is built from main)
#   --no-backup   skip the backup
#   --no-pull     don't pull new code (rebuild and restart what's checked out)
# ---------------------------------------------------------------------------
set -uo pipefail

log()  { printf '\n==> %s\n' "$1"; }
warn() { printf '\nWARNING: %s\n' "$1" >&2; }
die()  { printf '\nERROR: %s\n' "$1" >&2; exit 1; }

use_image=false
backup=true
pull_code=true
for arg in "$@"; do
  case "$arg" in
    --image) use_image=true ;;
    --no-backup) backup=false ;;
    --no-pull) pull_code=false ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $arg (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "Run this as root: sudo $0 $*"

cd "$(dirname "$(readlink -f "$0")")" || die "Can't find the repository folder"
[ -f docker-compose.yml ] || die "No docker-compose.yml next to update.sh"

command -v docker >/dev/null 2>&1 || die "Docker is required: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (the 'docker compose' command)."

# Runs git as the user who owns the checkout.
owner=$(stat -c %U .)
as_owner() {
  if [ "$owner" = root ]; then
    "$@"
  elif command -v runuser >/dev/null 2>&1; then
    runuser -u "$owner" -- "$@"
  else
    sudo -u "$owner" -H -- "$@"
  fi
}

env_value() { [ -f .env ] && sed -n "s/^$1=//p" .env | head -n 1; }

# --------------------------------------------------------------- the code
if $pull_code; then
  [ -d .git ] || die "This folder isn't a git clone. Use --no-pull, or update an install made by deploy.sh with: docker compose pull && docker compose up -d"
  log "Pulling the latest code (as $owner)"
  if [ -n "$(as_owner git status --porcelain --untracked-files=no)" ]; then
    as_owner git status --short --untracked-files=no >&2
    die "These files have local changes. Commit or undo them (git stash), then run this again."
  fi
  branch=$(as_owner git rev-parse --abbrev-ref HEAD)
  before=$(as_owner git rev-parse --short HEAD)
  as_owner git pull --ff-only || die "Couldn't pull $branch without a merge. Sort it out with git, then run this again."
  after=$(as_owner git rev-parse --short HEAD)
  if [ "$before" = "$after" ]; then
    echo "  Already up to date ($branch at $after)."
  else
    echo "  $branch: $before -> $after"
    as_owner git log --oneline --no-decorate "$before..$after" | head -n 20 | sed 's/^/    /'
  fi
fi

# --------------------------------------------------------------- settings
if [ ! -f .env ]; then
  log "Creating .env with a new encryption key (back it up with your data)"
  cp .env.example .env
  if command -v openssl >/dev/null 2>&1; then key=$(openssl rand -hex 32); else key=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'); fi
  sed -i "s/^RACKPATH_ENCRYPTION_KEY=.*/RACKPATH_ENCRYPTION_KEY=$key/" .env
  chmod 600 .env
  chown "$owner" .env 2>/dev/null || true
fi
[ -n "$(env_value RACKPATH_ENCRYPTION_KEY)" ] || die "RACKPATH_ENCRYPTION_KEY is empty in .env"

# --------------------------------------------------------------- backup
running=$(docker compose ps --status running --quiet rackpath 2>/dev/null)
if $backup && [ -n "$running" ]; then
  name="before-update-$(date +%Y%m%d-%H%M%S).db"
  log "Backing up the database to /data/$name (in the rackpath-data volume)"
  docker compose exec -T rackpath rackpath backup "/data/$name" ||
    die "The backup failed, so nothing was changed. Use --no-backup to update anyway."
fi

# --------------------------------------------------------------- build and restart
if $use_image; then
  log "Pulling the published images"
  docker compose pull || die "Couldn't pull the images"
  log "Restarting Rackpath"
  docker compose up -d --no-build || die "Couldn't start the container"
else
  log "Building Rackpath from the code (this takes a few minutes)"
  docker compose build --pull rackpath || die "The build failed; the running Rackpath was left as it was."
  # Caddy, when it's used, comes from its published image.
  docker compose pull --ignore-buildable >/dev/null 2>&1 || true
  log "Restarting Rackpath"
  docker compose up -d || die "Couldn't start the container"
fi

# --------------------------------------------------------------- check
port=$(env_value RACKPATH_PORT)
port=${port:-8080}
if command -v curl >/dev/null 2>&1; then
  ok=false
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${port}/api/health"; then ok=true; break; fi
    sleep 1
  done
  if ! $ok; then
    docker compose logs --tail 30 rackpath >&2
    die "Rackpath didn't answer on port $port after the update (its log is above)."
  fi
fi

version=$(docker compose exec -T rackpath rackpath version 2>/dev/null | tr -d '\r')
log "Rackpath is up to date${version:+: $version}"
if $backup && [ -n "$running" ]; then
  echo "  The backup taken before the update is /data/$name in the rackpath-data volume."
fi
