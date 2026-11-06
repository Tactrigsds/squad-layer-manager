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

## Variables

A command can include variables, which are filled in each time the task runs:

```
AdminBroadcast Now playing {{layer}} on {{server}}. Next up: {{nextLayer}}
```

| Variable           | Filled in with                                      |
| ------------------ | --------------------------------------------------- |
| `{{server}}`       | the server's name in SLM                            |
| `{{layer}}`        | the current layer, such as `Gorodok RAAS v1`        |
| `{{map}}`          | the current map                                     |
| `{{gamemode}}`     | the current gamemode                                |
| `{{team1}}`        | the faction on team 1 this match                    |
| `{{team2}}`        | the faction on team 2 this match                    |
| `{{nextLayer}}`    | the layer set next on the game server               |
| `{{nextMap}}`      | the map set next on the game server                 |
| `{{players}}`      | how many players are on the server                  |
| `{{maxPlayers}}`   | how many player slots the server has                |
| `{{queue}}`        | how many players are waiting to join                |
| `{{matchMinutes}}` | whole minutes since the match started               |
| `{{time}}`         | the time of day, as HH:MM in the server's time zone |
| `{{task}}`         | the task's name                                     |

A variable whose value SLM cannot read at that moment is left empty. SLM refuses to save a task that uses a variable
not in this table.

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
- `description`: what the task is for, shown under its name in the list of jobs.
- `servers`: the servers the task runs on.
- `trigger`: when the task runs. See above.
- `commands`: the RCON commands to run. See [Variables](#variables).
- `minPlayers`: a scheduled run is skipped while fewer players than this are on the server.
