# Squad Layer Manager

A Tool for managing the upcoming layers of a squad server.

## Deployment

Deployment is done via docker.

An image reflecting the `main` branch of the repository is available at `ghcr.io/tactrigsds/squad-layer-manager:latest`. the /app/data folder is expected to be bind-mounted for persistence

## Configuration

- `.env` contains sensitive secrets, and can be overridden by environment
  variables. Reference [src/server/env.ts](src/server/env.ts) for available
  options.

- The rest of the configuration is done via the app, though there is a script included `edit-global-settings.sh` if you need to manage it from outside the app

The database lives at `./data/db.sqlite3` by default. It used to default to `./data/main.sqlite3`: a deployment
carrying that older file needs to rename it (along with any `-wal`/`-shm` files) or set `DB_PATH` explicitly.
The app refuses to start if it finds one, rather than quietly coming up on an empty database.

## Backups

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

### Event history retention

`EVENT_HISTORY_RETENTION_PERIOD` prunes old server events (chat, kills, connects) as part of each backup run,
which is what keeps the database from growing without bound. Events are deleted for matches older than the
retention period, except that the 100 most recent matches per server are always kept regardless of age (the app
loads them at startup). Match records themselves are never deleted, only their events, and neither is the audit
log. The prune runs before the snapshot, so a backup never carries rows that were just dropped.

The first prune after turning this on clears the whole accumulated backlog and is much larger than the ones
that follow.

### Restoring

```sh
gunzip -c slm-backup-db-20260713-134504.sqlite3.gz > data/db.sqlite3
```

## Testing

Three suites, in increasing order of what they cost and what they cover:

- `pnpm test` — unit tests. No app, no server.
- `pnpm test:integration` — boots the real app against an emulated squad server (RCON + game log)
  and drives it as an admin would from in-game chat, asserting against the app's database and the
  commands the emulator received.
- `pnpm test:e2e` — the same, driven through the real client in a browser.

Both of the latter need the layer db (`data/layers_v*.sqlite3.gz`), which is a generated artifact:
run `pnpm preprocess` if you don't have one.

To run them the way CI does — inside the production image, driving the very server bundle that gets
deployed:

```sh
docker compose -f docker-compose.test.yaml run --rm --build tests
```

The image is the production one plus a browser, the test sources, and dev dependencies (see the
Dockerfile's `test` stage). The layer db is mounted rather than baked in, exactly as in production.

### Debugging a failing test with telemetry

A failing integration test is usually easier to read as a trace than as a log tail. The app under test
can export to the otel stack, labelled with the test that produced it:

```sh
docker compose up -d otel          # the collector + grafana, from docker-compose.yaml
SLM_TEST_OTEL=1 pnpm test:integration
```

Every span, log and metric that app emits then carries:

| attribute            | what it is                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `service.name`       | `slm-test` (rather than `squad-layer-manager`, so test telemetry never mixes with a real deployment's) |
| `slm.test.name`      | the test, e.g. `admin actions from the teams panel > disbanding a squad`                               |
| `slm.test.file`      | the spec file it came from                                                                             |
| `slm.test.run_id`    | one id for the whole run, so you can scope to it and then narrow to one test                           |
| `slm.test.server_id` | the emulated server                                                                                    |

Grafana (http://localhost:3001) — traces in Tempo:

```
{ resource.slm.test.name = "admin actions from the teams panel > disbanding a squad" }
```

and the app's logs for the same test in Loki:

```
{service_name="slm-test"} | slm_test_name = "admin actions from the teams panel > disbanding a squad"
```

A test that times out prints its `slm.test.run_id` and `slm.test.name` in the failure, so there's
something to paste. Telemetry is off unless `SLM_TEST_OTEL=1`: exporting costs time, and a test run
shouldn't need a collector to pass.

## Logging

Logging and traces can be managed via the otel-ltm stack, see [docker-compose.yaml](docker-compose.yaml) for an example.

## Battlemetrics

TODO double-check some of this
BM_PAT should be set to a personal access token for Battlemetrics. It needs permissions for:

- player flags (add/remove player flags. don't need to add new flags)
- player notes(read & createe)
- rcon(read, unclear why we need this one tbqh but experimentally we do)
