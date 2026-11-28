# Backups and updates

## What to back up

1. **The `rackpath-data` Docker volume**: the database and uploaded floor
   plans.
2. **`.env`**: it holds `RACKPATH_ENCRYPTION_KEY`. Without it, stored
   integration and SNMP credentials can't be read after a restore.

## Taking a backup

For a consistent copy while Rackpath runs:

```bash
cd rackpath
docker compose exec rackpath rackpath backup /data/rackpath-backup.db
```

The file lands in the volume. Copy it somewhere else, for example:

```bash
docker compose cp rackpath:/data/rackpath-backup.db ./rackpath-backup-$(date +%F).db
```

Schedule both lines (cron, a systemd timer) and keep copies off the server.

## Restoring

The database uses SQLite's write-ahead log, so a restore replaces the
database file **and removes the old log files** next to it. Rackpath's image
has no shell, so a small throwaway container does the copy:

1. Stop Rackpath:

   ```bash
   cd rackpath
   docker compose stop rackpath
   ```

2. Copy the backup in, from the folder holding `rackpath-backup.db`:

   ```bash
   docker run --rm --volumes-from rackpath -v "$PWD":/backup alpine \
     sh -c 'cp /backup/rackpath-backup.db /data/rackpath.db && rm -f /data/rackpath.db-wal /data/rackpath.db-shm && chown 65532:65532 /data/rackpath.db'
   ```

3. Make sure `.env` has the **same encryption key** as when the backup was
   taken.
4. Start it again: `docker compose start rackpath`.

> Practise a restore on a test machine before you need one.

## Updating

### Installed from a clone (`update.sh`)

```bash
cd Rackpath
sudo ./update.sh
```

It pulls the latest code, **backs up the database first**, rebuilds,
restarts and checks Rackpath answers again. It stops without changing
anything if you have local edits. Options:

- `--image`: use the published image instead of building (much quicker);
- `--no-backup`: skip the backup;
- `--no-pull`: rebuild and restart what's checked out.

### Installed with `deploy.sh`

```bash
cd rackpath
docker compose pull
docker compose up -d
```

Download the newest `docker-compose.yml` first if a release says it changed
(for example, network discovery needs the `sysctls` lines):

```bash
curl -fsSLO https://raw.githubusercontent.com/Stevy2191/Rackpath/main/docker-compose.yml
```

Running `deploy.sh` again also does this and keeps your settings.

### Database changes

New versions update the database by themselves when they start. Updates
are one-way, so take a backup first (`update.sh` does).

The published image is rebuilt from `main` a few minutes after each change.
If `docker compose pull` brings nothing new, wait and try again.
