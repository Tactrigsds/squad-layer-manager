# Upgrading and downgrading

## Upgrading

1. Read the "For operators" notes of every release since yours in [CHANGELOG.md](../../../CHANGELOG.md). A "Breaking"
   note describes a change that must be made to upgrade.
2. Run:

   ```sh
   docker compose pull && docker compose up -d
   ```

The same notes are logged when the upgraded app starts. Everyone signed in to SLM can read what changed on its What's
new page.

## Release channels

`SLM_IMAGE_TAG` in `.env` sets which image tag SLM follows. To switch, change it and upgrade.

| `SLM_IMAGE_TAG` | what it points at                                                         |
| --------------- | ------------------------------------------------------------------------- |
| `stable`        | the latest release. Releases group changes and come with release notes.   |
| `latest`        | every change as soon as it passes tests                                   |
| `2026.9.4`      | one release, which never changes. Releases are named `year.month.number`. |

An install without `SLM_IMAGE_TAG` follows `latest`.

## Migrations

SLM migrates its database when it starts. It backs the database up first, and applies nothing if the backup fails (see
[Backups and restoring](backups.md)).

To migrate by hand instead, set `DB_AUTOMIGRATE=0` in `.env`. Then stop the app, because a migration will not run
against a database another process has open, and run:

```sh
docker compose run --rm app pnpm db:migrate:prod
```

## Upgrading an older install

- An install that keeps its credentials in `.env` keeps working. To move them into `.env.secrets`, see
  [Moving credentials into the secrets file](secrets.md#moving-credentials-into-the-secrets-file).
- The BattleMetrics, Squad Browser and Steam credentials moved from the environment to the settings page. The first
  start after upgrading copies `BM_PAT`, `BM_ORG_ID`, `SQUADBROWSER_API_KEY`, `STEAM_API_KEY` and the matching
  `*_ENABLED` switches into the settings, and logs the copy. Remove them from `.env` and `.env.secrets` after that
  start. SLM no longer reads them, and warns on every start while one is still set.

## Downgrading

An upgrade migrates the database, and an older build cannot read a database a newer build has migrated. An older build
refuses to start on such a database, and its log names the build that last ran against it.

To go back, restore the backup taken before the upgrade, and pin the build that backup belongs to.
[Rolling back a bad upgrade](backups.md#rolling-back-a-bad-upgrade) describes both steps.

### Switching from latest to stable

`stable` is usually behind `latest`, so switching to it is a downgrade. Pin the running build instead, and switch to
`stable` once a stable release newer than that build is out:

1. Find the running build on SLM's about page, and set `SLM_IMAGE_TAG` to its `commit-<short sha>` tag (see
   [Pinning a version](backups.md#pinning-a-version)).
2. Watch [CHANGELOG.md](../../../CHANGELOG.md) for the next release.
3. Set `SLM_IMAGE_TAG=stable`, then upgrade.
