# Sandbox servers

A sandbox server is a squad server SLM runs itself. There is no game server behind it: SLM starts the emulator in
`src/emulator`, binds it to a loopback RCON port, and feeds its log lines into the managed server.

Use it to learn the queue, try a filter, rehearse a vote or reproduce a bug without affecting real players. SLM
creates one when a fresh install starts, so it opens to a working dashboard instead of a form asking for RCON
credentials.

## Using one

Set a server's connection type to `sandbox`, or let startup seed one (see below). Drive it from **Server Actions ->
Sandbox Controls**, which appears only on sandbox servers, and only for users holding `sandbox:control` on that server.
From there, connect fabricated players, speak as them in all or admin chat, form squads, end matches, and drop the RCON
connection to watch SLM reconnect.

The window embeds the [server console](server_console.md). The console is available on every server, under its
own permission.

The window shows nothing about the world except the fabricated players' names, which every action uses to address a
player. Check the roster, chat and queue on the dashboard. The dashboard shows what SLM sees, which is the thing under
test.

Use `pnpm emuctl` to drive the dev instance's emulator, which is a separate process from any sandbox server. Both
dispatch the same verbs (`src/models/sandbox.models.ts`, executed by `src/emulator/verbs.ts`), so neither can grow a
verb the other lacks.

## Seeding

`seedSandboxServer` (global settings, on by default) creates a server called `sandbox` at startup when none exists.
It is enabled immediately. It becomes the default server only when there is no other one, so an install already
running real servers gets the sandbox alongside them, never in front of them.

If the sandbox is deleted while the setting is on, the next restart creates a new one. Turn the setting off to remove it
for good.

## What is real and what is not

Everything between the connection and the UI runs the same code as for a live server. The sandbox talks real RCON
over a real socket, so packet framing, reconnection and command parsing are all exercised. Its log lines go through
the same parser as a live server's.

Three things differ from a live server:

- **BattleMetrics is off for sandbox servers.** Their players are fabricated, so lookups would spam a real org-wide
  service with ids belonging to nobody, and any flag or note written while looking at the sandbox would land on the
  live org. SLM does not start the BattleMetrics integration for them.
- **Admin lists are global**, so a fabricated player is not in one and does not read as an in-game admin. Chat
  commands from sandbox players resolve permissions the same way they would anywhere, which usually means denied.
- **The world is in memory.** An SLM restart starts a fresh world against a database that still remembers the old
  one's matches. The emulator survives a managed server restart (a settings edit does not reset it) but not a
  process restart.

## Sandbox data lands in the real tables

Server events, match history and app events are written for a sandbox exactly as for any other server, keyed by its
serverId. Audit-log and analytics queries that do not filter by server will include it. Keeping it in
the same tables makes the sandbox a faithful rehearsal, with no special code path of its own.

## Permissions

`sandbox:control` is server-scoped, so it is granted per sandbox and grants nothing on a real server. As with every
server-scoped permission, holding it implies `squad-server:view` for that server.

The control router can only act on an emulator SLM started. A serverId naming a real server finds no emulator
and stops there, so nobody can use the controls to drive a real server.
