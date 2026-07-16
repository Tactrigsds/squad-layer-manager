# Running many worktrees at once

Each worktree can run a complete, self-contained SLM: its own app, client, database and emulated squad
server, on its own ports. Nothing is shared with the main checkout except the credentials in `.env`, so any
number of experiments can run side by side without a second real game server between them.

```
pnpm dev:init     # once per worktree: claims a port slot, links .env, clones the database
pnpm dev:emu      # terminal 1: the emulated squad server (leave it running)
pnpm dev          # terminal 2: the app + client
```

`dev:init` prints the URL to open. Discord oauth is off for a dev instance, so log in with
`?login=<username>` -- any username in the cloned database works.

## Slots

A worktree claims a slot the first time it runs `dev:init` and keeps it. Every port is derived from the slot
number, so a browser tab pointed at a worktree stays valid across restarts:

| slot | app  | client | rcon | bm stub | inspect |
| ---- | ---- | ------ | ---- | ------- | ------- |
| 0    | 3100 | 3101   | 3102 | 3103    | 3104    |
| 1    | 3110 | 3111   | 3112 | 3113    | 3114    |

Slots start above the `.env` defaults (3000/5173), so an ordinary `pnpm server:dev` in the main checkout
never contends with one. `pnpm dev:slots` lists what every worktree holds; `pnpm dev:slots --release` gives
this worktree's back. A slot whose worktree has been deleted is reclaimed automatically.

The registry lives beside the shared git dir (`.git/slm-dev-slots.json`) because that is the only location
every worktree agrees on.

## The database

`dev:init` clones the main checkout's database, then re-points it at this worktree's emulator: the default
server gets a `local` connection to the emulator's log file and RCON port, and every other server is disabled
and has its connection scrubbed. Everything else -- match history, users, filters, settings -- survives, which
is the point: an experiment runs against realistic data rather than an empty db.

Re-clone at any time with `pnpm dev:db:clone --force` (stop the app first). `--from <path>` clones from
somewhere other than the main checkout.

Two safety properties, both of which the script enforces rather than assumes:

- **The source is never written.** The snapshot is `VACUUM INTO` over a read-only connection, which takes a
  read transaction and writes a new file. It cannot take the source's write lock or checkpoint its WAL, so
  cloning from a main checkout that is running the app is safe, and the clone still contains everything
  committed as of the snapshot. (A plain `cp` would be wrong twice over: it omits the `-wal`, so the clone
  silently loses recent writes, and it tears across concurrent ones.)
- **The destination is never swapped out from under a running app.** This is the half that needs care, and
  not for a reason WAL covers. WAL coordinates concurrent _connections_ to a database; replacing the file
  happens behind SQLite's back, where its locking has no say. An app left holding the unlinked file goes on
  writing to it -- successfully, and into nothing, since the inode has no name any more -- while serving reads
  from a database that is no longer on disk. Nothing errors. So the script takes an _exclusive_ lock and
  holds it from before the snapshot until after the rename: an app that boots into that window fails loudly
  on `SQLITE_BUSY` rather than becoming a ghost.

  Note that "has it open" is not the same as "holds the write lock". An app that happens to be idle holds no
  write lock, so a `BEGIN IMMEDIATE` probe succeeds against it and would pass exactly when it matters most.

The `-wal` is deleted with the file it belongs to, before the replacement takes the name. Left behind, it is
replayed over the new database as though it described it, and the reader silently sees the _old_ database's
contents -- with `integrity_check` reporting `ok`, so nothing anywhere reports a problem.

For contrast, `pnpm db:migrate` against a running app is a different and much milder case, because it writes
_through_ SQLite rather than around it: WAL serializes it, a racing write gets `SQLITE_BUSY` instead of being
lost, and the app re-prepares its statements against the new schema by itself. The worst case there is loud
errors from app code that disagrees with the schema, not silent loss.

No connection that reaches a real squad server survives a clone. The source's rows hold live RCON hosts and
passwords, and a merely-disabled row would keep them one settings-page toggle away from a dev instance
driving the production server.

## The emulator

`pnpm dev:emu` runs the emulated squad server (`src/emulator`) and a stub BattleMetrics API. It is a separate
process from the app on purpose: `pnpm dev` runs under `tsx watch` and restarts on every edit, which would
take the emulated world -- players, squads, match state, log history -- down with it each time. As its own
process the world outlives app reloads.

It writes the same `SquadGame.log` a real server does, and the app tails it over the same `local` code path.
There is no test-only transport in between.

`--players N` connects N players at startup; `--admins <steamid,...>` writes them into the `Admins.cfg` the
app reads.

### Driving it

`pnpm emuctl <command>`, from anywhere in the worktree, against the running emulator:

```sh
pnpm emuctl join Alice          # a player connects
pnpm emuctl squad Alice Able    # ...and leads a squad
pnpm emuctl chat Alice '!vote 1' # say something in all-chat -- this is how you drive chat commands
pnpm emuctl end 1               # end the match, team 1 winning
pnpm emuctl cycle               # drop and restore rcon, as a server restart would
pnpm emuctl rcon ListPlayers    # any raw rcon command
pnpm emuctl help                # the full list
```

The same commands are available as a REPL inside `pnpm dev:emu` when it has a terminal (`help` lists them
there too). Both front ends dispatch one registry (`src/dev/emu-control.ts`) against the same live world, so
neither can grow a verb the other lacks.

`emuctl` talks to the host over a unix socket at `data/dev/emu.sock`: no port to allocate, unreachable from
the network, and scoped to the worktree by living in its own `data/dev`. It exits non-zero and says what is
wrong if the command fails or no emulator is running, so it composes in scripts.

Quote anything with a `!` or spaces (`'!vote 1'`) -- it is a single argument, and your shell would otherwise
have opinions about it.

## What a dev instance cannot reach

Deliberately, and via env overrides in `src/dev/instance.ts`:

- **Discord** is off (`DISCORD_ENABLED=false`). The oauth callback is built from `ORIGIN`, so real login would
  need every slot's port registered as a redirect uri on the discord app. `QUERY_PARAM_AUTH_BYPASS` stands in.
  RBAC roles that come from discord are unavailable as a result; the `SUPER_USERS` bootstrap still applies.
- **BattleMetrics** points at the emulator's stub. The real API would write flags and notes to the live org.

Telemetry does go to the shared collector, tagged `slm.worktree=<name>` and `slm.dev.slot=<n>` so one grafana
can serve every instance.

## Env files

`dev:init` symlinks `.env` and `.env.secrets` back to the main checkout rather than copying them: a worktree
wants the same discord app, encryption key and battlemetrics credentials, and a copy would silently keep the
old values when one is rotated. The per-worktree differences (ports, `ORIGIN`, the overrides above) are
injected at spawn time instead.

The gitignored build artifacts a fresh worktree lacks (`assets/layer-engine.wasm`, `layer-db.json`) are
copied from the main checkout, or built if it has none either. They are copied rather than linked so a
worktree working on `layer-engine/` can rebuild over its own copy -- run `pnpm build:engine` if you change it.
