# Sandbox servers

A sandbox server is a squad server SLM runs itself. There is no game server behind it: SLM starts the emulator in
`src/emulator`, binds it to a loopback RCON port and feeds its log lines straight into the server slice.

It exists so an install has somewhere to learn the queue, try a filter, rehearse a vote or reproduce a bug without
touching anyone real. A fresh install gets one on startup, which is the difference between opening SLM to a working
dashboard and opening it to a form asking for RCON credentials.

## Using one

Set a server's connection type to `sandbox`, or let startup seed one (see below). Drive it from **Server Actions ->
Sandbox Controls**, which appears only on sandbox servers and only for users holding `sandbox:control` on that
server. From there you connect fabricated players, speak as them in all or admin chat, form squads, end matches and
drop the RCON connection to watch SLM reconnect.

The window shows nothing about the world except the puppet names, which is deliberate. Every verb addresses players
by name and that mapping is the only state the window cannot get elsewhere. What the roster, chat and queue actually
look like belongs on the dashboard, and reading it there is the honest test: it shows what SLM sees rather than what
the emulator meant.

`pnpm emuctl` drives the _dev instance's_ emulator, which is a separate process from any sandbox server. Both
dispatch the same verbs (`src/models/sandbox.models.ts`, executed by `src/emulator/verbs.ts`), so neither can grow
one the other lacks.

## Seeding

`seedSandboxServer` (global settings, on by default) creates a server called `sandbox` at startup when none exists.
It is enabled immediately, and becomes the _default_ server only when there is no other one -- an install already
running real servers gets the sandbox alongside them, never in front of them.

The setting, not the presence of the row, carries the intent. Deleting the sandbox while the setting is on gets you
a new one next restart; turn the setting off to be rid of it for good.

## What is real and what is not

Everything between the connection and the UI is the production path. The sandbox talks real RCON over a real socket,
so packet framing, reconnection and command parsing are all genuinely exercised, and its log lines go through the
same parser as a live server's. That is the point: a mock would not catch the bugs that actually happen.

Three things are deliberately not real:

- **BattleMetrics is off for sandbox slices.** Their players are fabricated, so lookups would spam a real org-wide
  service with ids belonging to nobody, and any flag or note written while looking at the sandbox would land on the
  live org. There is no per-server BM stub in production; the integration is simply not started.
- **Admin lists are global**, so a fabricated player is not in one and does not read as an in-game admin. Chat
  commands from sandbox players resolve permissions the same way they would anywhere, which usually means denied.
- **The world is in memory.** An SLM restart gives you a fresh world against a database that still remembers the old
  one's matches. The emulator survives slice restarts (a settings edit does not reset it) but not a process restart.

## Sandbox data lands in the real tables

Server events, match history and app events are written for a sandbox exactly as for any other server, keyed by its
serverId. Audit-log and analytics queries that do not filter by server will include it. This is a considered
trade-off: keeping it in the same tables is what makes the sandbox a faithful rehearsal rather than a special case
with its own code path.

## Permissions

`sandbox:control` is server-scoped, so it is granted per sandbox and grants nothing on a real server. As with every
server-scoped permission, holding it implies `squad-server:view` for that server.

The control router can only act on an emulator SLM started. A serverId naming a real server finds no instance and
stops there, so driving a real server through it is structurally impossible rather than prevented by a check.
