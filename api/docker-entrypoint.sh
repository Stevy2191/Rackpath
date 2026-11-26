#!/bin/sh
# Runs as root only long enough to hand /uploads to the "node" user (volumes
# created by older images are owned by root), then drops privileges.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /uploads
  exec su-exec node "$@"
fi
exec "$@"
