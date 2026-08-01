# Backups and restoring

Where backups come from, what the files mean, and how to put one back. Turning them on is part of
[installing](installing.md#36-backups).

## When backups happen

Backups happen for two reasons. One of them is not optional.

**Before every migration**, the database is snapshotted into `BACKUPS_DIR` first. This happens whether the app
applies migrations itself at boot (`DB_AUTOMIGRATE`, the default) or you run `pnpm db:migrate:prod` yourself, and it
is what you restore from if an upgrade turns out to have been a mistake. Nothing is applied if the snapshot fails.
The most recent pre-migration backup is never deleted by retention, however old it gets: it is the only way back
from the migration it was taken before.

**Periodic backups** are off by default. Set `AUTOMATIC_BACKUPS_PERIODIC` to a duration (e.g. `72h`) and the app
snapshots its database on that interval.

The two share a schedule and a retention window rather than running as separate systems. A backup taken to migrate
counts as that interval's backup, and is uploaded and recorded like any other, so an upgrade does not produce two
copies of the same database a minute apart, and the next periodic one is a full interval later.

Each run is also recorded in the audit log as a `BACKUP_CREATED` event.

## What the filenames mean

Every backup is named for where it came from:

```
slm-backup-<db>[-pre-migration]-<sha>-<yyyyMMdd>-<HHmmss>.sqlite3.gz

slm-backup-db-a6047f44deb0-20260713-134504.sqlite3.gz                 a periodic backup
slm-backup-db-pre-migration-9c1f0a2b3d4e-20260713-134016.sqlite3.gz   taken before a migration
```

`<db>` is the source database's filename without its extension, and retention only deletes names matching it, so two
instances sharing a directory cannot prune each other's backups. `<sha>` is the short git sha of the build that
owned the database when the snapshot was taken, recorded inside it in `_slm_meta`, or `unknown` if the database
carried no stamp. For a pre-migration backup that is the version being upgraded _from_, which is the one a rollback
wants. The timestamp sorts chronologically.

## Uploading to SFTP

Setting `BACKUP_SFTP_HOST` uploads each backup to that host as it is taken.

| variable                             | default | what it does                                           |
| ------------------------------------ | ------- | ------------------------------------------------------ |
| `BACKUP_SFTP_HOST`                   | unset   | setting this uploads each backup to that host          |
| `BACKUP_SFTP_PORT`                   | `22`    |                                                        |
| `BACKUP_SFTP_USERNAME`               |         | required when a host is set                            |
| `BACKUP_SFTP_PASSWORD`               |         | this or a private key is required when a host is set   |
| `BACKUP_SFTP_PRIVATE_KEY_PATH`       |         | path to a private key, as an alternative to a password |
| `BACKUP_SFTP_PRIVATE_KEY_PASSPHRASE` |         | if the key needs one                                   |
| `BACKUP_SFTP_DIR`                    | `.`     | remote directory, created if missing                   |

`BACKUPS_RETAIN_COUNT` applies remotely as well as locally.

Two SLM instances must not share a `BACKUP_SFTP_DIR` unless their databases are named differently. Retention deletes
any backup matching its own name, so they would prune each other's.

A failed upload does not fail the backup. The local copy is still written, and the audit event records that it never
left the box.

## Restoring

`restore.sh` puts a backup back. Stop the app first, and start it again yourself once `docker-compose.yaml` points at
the image the restored database belongs to:

```sh
docker compose stop app
./restore.sh --latest
docker compose up -d app
```

It refuses to run while the app is up. Which backup it puts back:

```sh
./restore.sh --list                   # what backups there are, and the build each belongs to
./restore.sh --inspect --latest       # which build a backup belongs to, without restoring it
./restore.sh --pre-migration          # the snapshot taken before the last migration: undo a bad upgrade
./restore.sh --latest                 # the newest backup of any kind
./restore.sh --commit-sha commit-a6047f4    # the newest backup taken by a given build
./restore.sh --from slm-backup-db-a6047f44deb0-20260713-134504.sqlite3.gz    # a specific one
```

`--from` also takes a path, which is how you restore a backup fetched back off the SFTP target. Drop it in
`data/backups` or pass the full path.

Because the filename carries the owning build's sha, `--list` shows the build, and `--commit-sha` can pick the
newest backup from a particular version without unpacking anything. `--commit-sha` accepts a full sha, a short one,
or a `commit-<sha>` image tag, and pairs with `--pre-migration` to restrict the search to pre-migration snapshots.

`--inspect` pairs with a backup selector (`--latest`, `--pre-migration`, `--from`) and changes nothing. It unpacks
the backup and reports which app build the database belongs to, which image tag to pin, and how far behind the
current build it is. Run it first when rolling back an upgrade, so you know which version to point
`docker-compose.yaml` at before you start the app.

The database being replaced is kept, renamed to `db.sqlite3.replaced-<timestamp>` next to it, because a restore is
otherwise the one operation with no undo. Delete it once you are happy. The restore is checked (`integrity_check`)
before anything is moved, so a corrupt archive costs nothing.

Prefer this over doing it by hand. `gunzip -c backup.gz > data/db.sqlite3` looks complete and is not: the old `-wal`
file is still sitting there, SQLite replays it over the file you just restored, and you silently get the **old**
database back, with `integrity_check` calling it fine. Restoring while the app is running is worse, because the app
goes on writing to a database that is no longer at that path, and those writes are lost.

## Pinning a version

`docker-compose.yaml` ships pointing at `:latest`, which is whichever build most recently passed CI on `main`.
Pinning means replacing that tag with one that names a single build, so `docker compose up -d` keeps giving you the
same one.

CI publishes every commit as `commit-<short sha>`, so any build that has ever existed can be pinned:

```yaml
services:
   app:
      # image: ghcr.io/tactrigsds/squad-layer-manager:latest
      image: ghcr.io/tactrigsds/squad-layer-manager:commit-9c1f0a2
```

Then pull the pinned build and start on it:

```sh
docker compose pull app
docker compose up -d app
```

While it is pinned, `docker compose pull && docker compose up -d` no longer upgrades anything: a `commit-` tag
always resolves to that one build. To upgrade again, put `:latest` back and pull.

You do not have to guess a sha. `./restore.sh --list` shows the build every backup belongs to, `--inspect` names the
tag for one of them, and the app's own version is on its about page.

## Rolling back a bad upgrade

Roll the image back too. Restoring a pre-migration backup and then starting the same version just applies the same
migration again. Each database is stamped with the git sha and branch of the app that last ran against it, so the
backup can tell you which build it belongs to.

Ask which build that is before restoring anything:

```sh
./restore.sh --inspect --pre-migration
```

```
inspecting slm-backup-db-pre-migration-9c1f0a2b3d4e-20260713-134016.sqlite3.gz
    pre-migration, commit-9c1f0a2, taken 2026-07-13 13:40:16, 24.8 MB

This backup belongs to build main;9c1f0a2b3d4e. Pin the `commit-9c1f0a2` image tag in docker-compose.yaml before starting the app.
It is 2 migration(s) behind the current build (0031_seed_pools, 0032_pool_constraints).
```

Restore first, on the image you are currently running, and pin afterwards:

```sh
docker compose stop app
./restore.sh --pre-migration
```

The restore repeats the tag and exits non-zero, because the database it just put back is behind the image
`docker-compose.yaml` still names. That is deliberate: it is what stops
`./restore.sh --pre-migration && docker compose up -d app` from starting the app on a database it would migrate
straight back up. Pin `commit-9c1f0a2` as above, then:

```sh
docker compose pull app
docker compose up -d app
```
