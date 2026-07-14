# Squad Layer Manager

A Tool for managing the upcoming layers of a squad server.

## Deployment & Hosting.

Deployment is done via docker.

An image reflecting the `main` branch of the repository is available at `ghcr.io/tactrigsds/squad-layer-manager:latest`. the /app/data folder is expected to be bind-mounted for persistence data persistence

### Configuration

`.env` contains sensitive secrets and some basic configuration options, and can be overridden by environment
variables. Reference [src/server/env.ts](src/server/env.ts) for available
options.

The rest of the configuration is done via the app on the settings page, though there is a script included `edit-global-settings.sh` if you need to manage it from outside the app, and while the app isn't running.

The database lives at `./data/db.sqlite3` by default.
The app refuses to start if it finds one, rather than quietly coming up on an empty database.
On boot, -wal and -shm files will be created alongside `db.sqlite3`. These are safe to delete _ONLY_ when the app is not running.

### The Layer data

The app runs on a _pair_ of artifacts, always of the same version:

- `layers_v<version>.bin.gz` -- a set of all possible layer configurations (layer + factions + units) in a columnar
  format, plus any scoring we attribute to each layer.
- `layer-data_v<version>.json` -- the components (maps, factions, units, extra-column definitions) the table's
  encoded values refer to.

Neither is any use without the other -- a table read against the wrong components silently resolves to the wrong
layers -- so the two are only ever treated as a pair, and only when they sit in the same directory under the same
version. Half a pair is a startup error rather than something the app quietly works around.

Both are checked in under `assets/layers` and ship inside the docker image, so the app boots as-is and there is
nothing to download.

To run a different layer version than the one the image ships, drop a complete pair into `data/` (the directory a
deployment mounts). **Any** complete pair there is preferred over the one in the image, including an older one, so
moving a running deployment between layer versions is a matter of dropping files into the mount and restarting.
`<version>` is parsed as semver and the highest one in the winning directory is used, unless `LAYERS_VERSION` pins
one. `LAYERS_DIR` adds a directory that is searched ahead of both.

You can build your own pair with alternate scoring and different layers/game versions: see `src/scripts/preprocess.ts`
(`pnpm preprocess`), which writes both halves into `assets/layers` (override with `LAYERS_OUTPUT_DIR`).

#### Backups

Off by default. Set `AUTOMATIC_BACKUPS_PERIODIC` to a duration (e.g. `72h`) and the app will snapshot its
database on that interval, optionally shipping each one to an SFTP host.

A snapshot is taken with sqlite's online backup API, so it is a consistent point-in-time copy taken without
locking the app out of its own database, and it is gzipped (typically 5-10x smaller) before being stored or
uploaded. Backups are named after the database they came from, e.g. `slm-backup-db-20260713-134504.sqlite3.gz`.
Each run is recorded in the audit log as a `BACKUP_CREATED` event.

The schedule is anchored to the last backup that actually happened, not to boot, so a server restarted more
often than the interval still gets backed up. A backup that came due while the app was down is taken shortly
after it comes back up.

| variable                             | default          | what it does                                                  |
| ------------------------------------ | ---------------- | ------------------------------------------------------------- |
| `AUTOMATIC_BACKUPS_PERIODIC`         | unset (disabled) | how often to back up, e.g. `72h`                              |
| `EVENT_HISTORY_RETENTION_PERIOD`     | unset (disabled) | prune server events older than this, e.g. `90d` (see below)   |
| `BACKUPS_DIR`                        | `./data/backups` | where backups are written                                     |
| `BACKUPS_RETAIN_COUNT`               | `10`             | how many to keep, locally and remotely. `0` keeps all of them |
| `BACKUP_SFTP_HOST`                   | unset (disabled) | setting this uploads each backup to that host                 |
| `BACKUP_SFTP_PORT`                   | `22`             |                                                               |
| `BACKUP_SFTP_USERNAME`               |                  | required when a host is set                                   |
| `BACKUP_SFTP_PASSWORD`               |                  | this or a private key is required when a host is set          |
| `BACKUP_SFTP_PRIVATE_KEY_PATH`       |                  | path to a private key, as an alternative to a password        |
| `BACKUP_SFTP_PRIVATE_KEY_PASSPHRASE` |                  | if the key needs one                                          |
| `BACKUP_SFTP_DIR`                    | `.`              | remote directory, created if missing                          |

Two SLM instances must not share a `BACKUP_SFTP_DIR` unless their databases are named differently: retention
deletes any backup matching its own name, so they would prune each other's.

A failed upload does not fail the backup. The local copy is still written, and the audit event records that it
never left the box.

#### Event history retention

`EVENT_HISTORY_RETENTION_PERIOD` prunes old server events (chat, kills, connects) as part of each backup run,
which is what keeps the database from growing without bound. Events are deleted for matches older than the
retention period, except that the 100 most recent matches per server are always kept regardless of age (the app
loads them at startup). Match records themselves are never deleted, only their events, and neither is the audit
log. The prune runs before the snapshot, so a backup never carries rows that were just dropped.

The first prune after turning this on clears the whole accumulated backlog and is much larger than the ones
that follow.

#### Restoring

```sh
# while the application is OFF:
# delete or move the existing database and its -wal and -shm files
rm data/db.sqlite3*
gunzip -c slm-backup-db-20260713-134504.sqlite3.gz > data/db.sqlite3
```

## Logging

Logging and traces can be managed via the otel-ltm stack, see [docker-compose.yaml](docker-compose.yaml) for an example.

## Battlemetrics

TODO double-check some of this
BM_PAT should be set to a personal access token for Battlemetrics. It needs permissions for:

- player flags (add/remove player flags. don't need to add new flags)
- player notes(read & createe)
- rcon(read, unclear why we need this one tbqh but experimentally we do)
