# Development workspaces

Every checkout can run a complete, self-contained SLM: its own app, client, database and emulated Squad server, on
its own ports. A workspace is the checkout where `pnpm dev` runs. It may be the main checkout, a Git worktree, a
standalone clone, or one created by an agent.

```sh
pnpm worktree new <name>   # optional: creates a Git worktree, installs and provisions it
cd ~/projects/slm/<name>
pnpm dev                   # provisions and runs the workspace
```

`pnpm dev` prints the one URL the workspace answers on. That URL carries a `?login=`, so opening it lands you signed
in.

For an existing checkout, including one made by `git worktree add` or an agent, run `pnpm dev` there. It provisions
the workspace before starting it.

## Where worktrees live

`pnpm worktree new` defaults to `~/projects/slm/<name>`, outside the repo. `SLM_WORKTREE_ROOT` overrides that
location, and `SLM_WORKTREE_BASE=head` branches from local HEAD instead of `origin/HEAD`. This is only the default
for the creator. `pnpm dev` works from any checkout location.

They are outside the repo on purpose. A worktree nested in the checkout is a second copy of the tree inside the
first one, and every tool that walks the repo, git's own ignore rules most of all, has to be taught to pretend it is
not there.

Claude Code creates worktrees through the `WorktreeCreate` and `WorktreeRemove` hooks in `.claude/settings.json`,
which hand the work to `scripts/worktree.mjs`. So `EnterWorktree` lands in the same place `pnpm worktree new` does,
with node_modules and the gitignored artifacts included. `pnpm worktree migrate` relocates worktrees left under the old
`.claude/worktrees`. It reports what it would do until passed `--apply`, and skips any with processes still running
in them.

## The one url

`http://localhost:<client port>/?login=<user>`. Everything is behind it: the vite dev server proxies every api
route, the websocket and each page request to the app, so the app's own port is an implementation detail. `pnpm dev
--url` prints it without starting the app.

The login is a super user from the cloned database, resolved once during provisioning and kept in the slot registry.
Discord oauth is off for a dev instance, so `?login=<username>` is how anyone signs in, and any username in the
cloned database works.

## Slots

A workspace claims a slot the first time it runs `pnpm dev` and keeps it. Every port is derived from the slot number,
so a browser tab pointed at a workspace stays valid across restarts:

| slot | app  | client | rcon | bm stub | inspect |
| ---- | ---- | ------ | ---- | ------- | ------- |
| 0    | 3100 | 3101   | 3102 | 3103    | 3104    |
| 1    | 3110 | 3111   | 3112 | 3113    | 3114    |

Slots start above the `.env` defaults (3000/5173), so an ordinary `pnpm server:dev` never contends with one. A slot
whose checkout has been deleted is reclaimed automatically.

The registry lives beside the shared git dir (`.git/slm-dev-slots.json`), the only location every worktree agrees
on.

## The database

Provisioning clones the primary checkout's database, then re-points it at this workspace's emulator: the default server
gets a `local` connection to the emulator's log file and RCON port, and every other server is disabled and has its
connection scrubbed. Match history, users, filters and settings all survive, so an experiment runs against realistic
data rather than an empty db.

Re-clone at any time with `pnpm dev --reset-data` after stopping the app. The clone is a `VACUUM INTO` snapshot over
a read-only connection, so cloning from a primary checkout that is running the app is safe and never touches the
source.

No connection that reaches a real squad server survives a clone. The source's rows hold live RCON hosts and
passwords, and a merely-disabled row would keep them one settings-page toggle away from a dev instance driving the
production server.

## The emulator

The emulated squad server (`src/emulator`) plus a stub BattleMetrics API. `pnpm dev` starts one unless this worktree
already has it running, and it stays a separate process either way: its world (players, squads, match state) has to
survive the app's watch restarts, and it would not if the app hosted it.

It writes the same `SquadGame.log` a real server does, and the app tails it over the same `local` code path.

`pnpm dev --emu-only` runs it alone, with the repl below on stdin, for a session that outlives several `pnpm dev`s or that
wants its startup flags. `--players N` connects N players at startup, and `--admins <steamid,...>` writes them into
the `Admins.cfg` the app reads. `pnpm dev --no-emu` then leaves it alone.

### Driving it

`pnpm emuctl <command>`, from anywhere in the worktree, against the running emulator:

```sh
pnpm emuctl join Alice          # a player connects
pnpm emuctl squad Alice Able    # ...and leads a squad
pnpm emuctl chat Alice '!vote 1' # say something in all-chat: this is how you drive chat commands
pnpm emuctl end 1               # end the match, team 1 winning
pnpm emuctl cycle               # drop and restore rcon, as a server restart would
pnpm emuctl rcon ListPlayers    # any raw rcon command
pnpm emuctl help                # the full list
```

The same commands are available as a REPL inside `pnpm dev --emu-only` when it has a terminal (`help` lists them there
too). Both front ends dispatch one registry (`src/dev/emu-control.ts`) against the same live world, so neither can
grow a verb the other lacks.

`emuctl` talks to the host over a unix socket at `data/dev/emu.sock`: no port to allocate, unreachable from the
network, and scoped to the worktree by living in its own `data/dev`. It exits non-zero and says what is wrong if the
command fails or no emulator is running, so it composes in scripts.

Quote anything with a `!` or spaces (`'!vote 1'`). It is a single argument, and your shell would otherwise have
opinions about it.

### Admins and player groups

The emulator keeps an `Admins.cfg` at `data/dev/Admins.cfg`, which the app reads back as an ordinary `local`
admin list. It ships with the same groups a seeded sandbox does -- `Admin`, `Watchlist`, `ArmorPlayer`,
`SquadLeader`, `Regular` -- and players are spread across them in a fixed pattern as they connect, so a roster
you just joined breaks down into something rather than reading as one undifferentiated block. Provisioning
installs the matching grouping (`Admin List`) in the instance's settings, which is what the teams panel groups
by and what the stats breakdown charts.

Edit any of it with the same verbs the sandbox window offers:

```sh
pnpm emuctl set-player-groups Alice Admin Regular  # put a player in groups (none removes them from the list)
pnpm emuctl define-group Donor reserve             # add a group, or change what it grants
pnpm emuctl delete-group Donor
```

A change is written to the file immediately, but the app re-reads a local admin list every 30 seconds, so give
it that long to reach the roster.

## What a dev instance cannot reach

Blocked deliberately, via env overrides in `src/dev/instance.ts`:

- **Discord** is off (`DISCORD_ENABLED=false`). The oauth callback is built from `ORIGIN`, so real login would need
  every slot's port registered as a redirect uri on the discord app. `QUERY_PARAM_AUTH_BYPASS` stands in. RBAC roles
  that come from discord are unavailable as a result, but the `SUPER_USERS` bootstrap still applies.
- **BattleMetrics** points at the emulator's stub. The real API would write flags and notes to the live org.

Telemetry does go to the shared collector, tagged `slm.worktree=<name>` and `slm.dev.slot=<n>` so one grafana can
serve every instance.

## Env files

For linked Git worktrees, provisioning symlinks missing `.env` and `.env.secrets` files back to the primary checkout
rather than copying them. A worktree wants the same Discord app, encryption key and BattleMetrics credentials, and a
copy would silently keep the old values when one is rotated. A standalone clone keeps its local environment files.
The per-workspace differences (ports, `ORIGIN`, and the overrides above) are injected at spawn time instead.

The gitignored build artifacts a fresh checkout lacks (`assets/layer-engine.wasm`, `layer-db.json`) are copied from
the primary checkout by whatever creates the worktree, provisioning included, so nothing has to reach a dev instance
before the engine is there. They are copied rather than linked so a worktree working on `layer-engine/` can rebuild
over its own copy. Run `pnpm build:engine` if you change it.

The list of them lives in `scripts/worktree.mjs` (`ensure-artifacts`), which is dependency-free plain node because
it runs from a `WorktreeCreate` hook against a worktree with no node_modules yet. Only provisioning asks it to build a
missing engine, since a hook that spends minutes in cargo reads as a hung one.
