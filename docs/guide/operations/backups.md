# Backups and restoring

This page describes when SLM backs up its database, how the backup files are named, and how to restore one. Periodic
backups are turned on during [installing](../../installing.md#6-backups).

## When backups happen

SLM backs up its database before every migration, and on a schedule if one is set.

**Before every migration**, SLM snapshots the database into `BACKUPS_DIR`. This backup cannot be turned off. SLM takes it whether the app applies
migrations itself at boot (`DB_AUTOMIGRATE`, the default) or `pnpm db:migrate:prod` is run by hand, and it is the
snapshot to restore from if an upgrade goes wrong. Nothing is applied if the snapshot fails. The most recent
pre-migration backup is never deleted by retention, however old it gets: it is the only way back from the migration it
was taken before.

**Periodic backups** are off by default. Set `AUTOMATIC_BACKUPS_PERIODIC` to a duration (e.g. `72h`) and the app
snapshots its database on that interval.

A backup taken before a migration counts as that interval's periodic backup.

## Backup names

```
slm-backup-db-a6047f44deb0-20260713-134504.sqlite3.gz                 a periodic backup
slm-backup-db-pre-migration-9c1f0a2b3d4e-20260713-134016.sqlite3.gz   taken before a migration
```

The sha names the SLM build that last ran against the database. For a pre-migration backup, that is the version being
upgraded from, which is the one a rollback needs.

## Uploading to SFTP

When `BACKUP_SFTP_HOST` is set, SLM uploads each backup to that host as it is taken.

| variable                             | default | what it does                                           |
| ------------------------------------ | ------- | ------------------------------------------------------ |
| `BACKUP_SFTP_HOST`                   | unset   | SLM uploads each backup to this host                   |
| `BACKUP_SFTP_PORT`                   | `22`    |                                                        |
| `BACKUP_SFTP_USERNAME`               |         | required when a host is set                            |
| `BACKUP_SFTP_PASSWORD`               |         | this or a private key is required when a host is set   |
| `BACKUP_SFTP_PRIVATE_KEY_PATH`       |         | path to a private key, as an alternative to a password |
| `BACKUP_SFTP_PRIVATE_KEY_PASSPHRASE` |         | if the key needs one                                   |
| `BACKUP_SFTP_DIR`                    | `.`     | remote directory, created if missing                   |

`BACKUPS_RETAIN_COUNT` applies remotely as well as locally.

Two SLM instances must not share a `BACKUP_SFTP_DIR` unless their databases are named differently. Retention deletes
any backup matching its own name, so they would prune each other's.

A failed upload does not fail the backup. The local copy is still written, and the audit event records that it was
not uploaded.

## Restoring

Run `restore.sh` to put a backup back. Stop the app first, and start it again once `SLM_IMAGE_TAG` in `.env` names
the image the restored database belongs to:

```sh
docker compose stop app
./restore.sh --latest
docker compose up -d app
```

It refuses to run while the app is up. Choose which backup it puts back:

```sh
./restore.sh --list                   # what backups there are, and the build each belongs to
./restore.sh --inspect --latest       # which build a backup belongs to, without restoring it
./restore.sh --pre-migration          # the snapshot taken before the last migration: undo a bad upgrade
./restore.sh --latest                 # the newest backup of any kind
./restore.sh --commit-sha commit-a6047f4    # the newest backup taken by a given build
./restore.sh --from slm-backup-db-a6047f44deb0-20260713-134504.sqlite3.gz    # a specific one
```

`--from` also takes a path. Use it to restore a backup fetched back off the SFTP target. Drop it in `data/backups` or
pass the full path.

`--inspect` changes nothing. It reports which build a backup belongs to, which image tag to pin, how far behind the
current build it is, and whether its secrets decrypt with this install's `SETTINGS_ENCRYPTION_KEY`.

A backup is only complete with the key that encrypted it. Restored under a different key, the database comes up with
every server disabled and every integration token unset, and each has to be re-entered on the settings page. Keep the
key wherever the backups are kept, and restore the two together. If the backup belongs to an older key that is still
available, set that key as `SETTINGS_ENCRYPTION_KEY_PREVIOUS` for the first boot after restoring. That boot re-encrypts
everything under the current key, and the variable can be removed again (see
[The encryption key](secrets.md#the-encryption-key)).

The database being replaced is kept next to it, renamed to `db.sqlite3.replaced-<timestamp>`, so the restore can be
undone. Delete it once the restore is confirmed.

Do not restore by hand by unzipping a backup over `data/db.sqlite3`. SQLite replays the old database's leftover write log
over the restored file, and the old database silently comes back.

## Pinning a version

`SLM_IMAGE_TAG` in `.env` sets which image tag the app runs (see [Release channels](upgrading.md#release-channels)).
Pinning means setting it to a tag that names a single build, so `docker compose up -d` keeps running the same one.

A release such as `2026.9.4` is one build. CI also publishes every commit as `commit-<short sha>`, so any build that
has ever existed can be pinned:

```sh
SLM_IMAGE_TAG=commit-9c1f0a2
```

Then pull the pinned build and start on it:

```sh
docker compose pull app
docker compose up -d app
```

While it is pinned, `docker compose pull && docker compose up -d` no longer upgrades anything: a release or `commit-`
tag always resolves to that one build. To upgrade again, set `SLM_IMAGE_TAG` back to `stable` or `latest` and pull.

`./restore.sh --list` shows the build every backup belongs to, `--inspect` names the
tag for one of them, and the app's own version is on its about page.

## Rolling back a bad upgrade

Roll the image back too. Restoring a pre-migration backup and then starting the same version applies the same
migration again.

Ask which build that is before restoring anything:

```sh
./restore.sh --inspect --pre-migration
```

```
inspecting slm-backup-db-pre-migration-9c1f0a2b3d4e-20260713-134016.sqlite3.gz
    pre-migration, commit-9c1f0a2, taken 2026-07-13 13:40:16, 24.8 MB

This backup belongs to build main;9c1f0a2b3d4e. Pin it by setting `SLM_IMAGE_TAG=commit-9c1f0a2` in .env before starting the app.
It is 2 migration(s) behind the current build (0031_seed_pools, 0032_pool_constraints).
```

Restore first, on the image currently running, and pin afterwards:

```sh
docker compose stop app
./restore.sh --pre-migration
```

The restore repeats the tag and exits non-zero, because the restored database is behind the image `SLM_IMAGE_TAG`
still names. Pin `commit-9c1f0a2` as above, then:

```sh
docker compose pull app
docker compose up -d app
```
