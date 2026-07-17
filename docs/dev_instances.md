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
somewhere other than the main checkout. The clone is a `VACUUM INTO` snapshot over a read-only connection, so
cloning from a main checkout that is running the app is safe and never touches the source.

No connection that reaches a real squad server survives a clone. The source's rows hold live RCON hosts and
passwords, and a merely-disabled row would keep them one settings-page toggle away from a dev instance
driving the production server.

## The emulator

`pnpm dev:emu` runs the emulated squad server (`src/emulator`) and a stub BattleMetrics API. Run it as its own
process (not under `pnpm dev`) so its world -- players, squads, match state -- survives app reloads.

It writes the same `SquadGame.log` a real server does, and the app tails it over the same `local` code path.

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
