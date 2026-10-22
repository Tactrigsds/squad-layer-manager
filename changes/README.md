# Changelog fragments

Each pull request that changes something a user or operator can notice adds one file here. `pnpm release` moves
them into `changelog/<version>/` and regenerates `CHANGELOG.md`. The app shows them on its What's new page.

Every fragment in changes/ is unreleased, because `pnpm release` moves all of them out. A pull request that follows
up an unreleased change edits that change's fragment instead of adding a second one.

## Does this change need one?

It does if someone could notice it without reading the code or the logs:

- **users**: anything in the web UI, in game (warns, commands, broadcasts) or in Discord, including a speedup
  people can feel
- **operators**: env vars, config, the Docker setup, backups and restore, the plugin API, or what an upgrade does
  (a long or irreversible migration)

Refactors, tests, CI, internal docs and fixes to bugs that never shipped do not. Put `Changelog: none` in the PR
description or a commit message instead, so the choice is written down. A reason can follow on the same line:
`Changelog: none, fixes a bug that never shipped`. The pre-push hook only sees commit messages. A PR made only of
`refactor`, `test`, `ci`, `style`, `chore`, `docs` or `build` commits needs neither.

A breaking commit (`feat!:`) always needs an `operators` fragment saying what an upgrade has to do.

A `breaking` fragment's first sentence names the setups that must change, such as "A plugin of your own that reads
`note.author`" or "A `SETTINGS_ENCRYPTION_KEY` shorter than 16 characters". An operator whose setup the fragment does not name
skips the note. A change the upgrade migrates on its own is breaking only for what the migration cannot reach, such as
scripts or plugins that write the old shape, so name those.

## The format

Name the file after the change, in lower case with dashes: `history-short-links.md`. The name is the entry's id and
its link on the What's new page, so it has to be unique across every release.

```md
---
audience: users # users | operators
kind: changed # added | changed | fixed | removed | breaking (operators only)
minor: false # optional. true collapses it under "smaller changes" and leaves it out of the unread count
tutorial: player-management # optional. adds a "Try the tutorial" button
---

History links are shorter. Old links still open.

Optional detail, in markdown, after a blank line.
```

Write the first line for the people it affects. Describe what changed for them, not what the code does.

## Checking

`pnpm changelog:check` validates every fragment. CI and the pre-push hook also check that a branch adds a fragment,
or edits an unreleased one, when it needs one.
