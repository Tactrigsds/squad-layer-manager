# scheduled-commands

Runs RCON commands on your game servers on a schedule.

## Tasks

Each entry in **Tasks** is one task: a list of commands, the servers it runs on, and a trigger that decides when it
runs. The commands run in order, such as:

```
AdminBroadcast Join our discord at discord.gg/example
AdminSetFogOfWar 1
```

A task runs only on the servers listed in its **Servers**. A task with no servers listed never runs.

## Triggers

| Trigger       | Runs                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `interval`    | every **every**, counted from when the last run finished. The first run is as soon as it is saved. |
| `cron`        | at the times a cron pattern names, such as `0 20 * * *` for 20:00 every day                        |
| `match-start` | **after** the match starts, then every **repeatEvery** until the match ends, if it is set          |
| `round-end`   | **after** the match ends, unless the next match has started by then                                |

A `cron` task reads its pattern in **timezone**. With no time zone set, it uses SLM's default time zone from the
global settings.

A `match-start` task does not run on a match that was already going when SLM first connected to the server, because
SLM does not know when that match started. It runs from the next match on.

A run that SLM misses, such as while it restarts, still happens if SLM is back within a minute. Otherwise it is
skipped.

## Running a task by hand

Each task is listed under the plugin's jobs, on the settings page, with its next run and how its last run went. Click
_Run now_ to run its commands straight away. A run by hand ignores **minPlayers**.

## The activity feed

Each command appears in the server's activity feed and the audit log as an RCON command run by Scheduled Commands. A
task with a failed command shows as failed under the plugin's jobs, with the error from the game server.

## Settings

- `name`: the task's name in settings. Two tasks cannot share a name, ignoring case and punctuation. Renaming a task
  clears its run history, so an `interval` task runs straight away after a rename.
- `servers`: the servers the task runs on.
- `trigger`: when the task runs. See above.
- `commands`: the RCON commands to run.
- `minPlayers`: a scheduled run is skipped while fewer players than this are on the server.
