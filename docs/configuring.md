# Configuring SLM

This guide assumes you already have a running instance of SLM. See [installing.md](installing.md) if you do not.

SLM is configured mostly through the settings page. Most of those settings are not relevant yet, but a few things
have to be set up before SLM can be used on your server.

Every setting can also be edited through a built-in JSON editor.

## What a fresh install starts with

An empty database is seeded once, on its first boot, so there is something to look at before anything is configured:

- Four filters, owned by `SLM` rather than by a person, since nobody has signed in yet:
   - **Main Pool** - the competitive pool, minus the two below it. It is written as a composition (`Z_Pool`,
     excluded from Similar Factions, included in No Mech on Hilly Maps) rather than as one flat expression, so
     editing either of those changes what the pool means.
   - **No Mech on Hilly Maps** - keeps mechanized and armored matchups off the maps their vehicles cannot get
     around.
   - **Similar Factions** - both teams field factions of the same nation, which tends to produce teamkills.
   - **Seeding** - small layers to run while the server fills up.
- A [sandbox server](sandbox_servers.md), enabled and default, whose pool is configured from those filters. Main
  Pool is the pool filter, Seeding and Similar Factions indicate their matches, and No Mech on Hilly Maps is offered
  during layer selection, starting unselected.

None of it is reconciled on later boots. Edit or delete any of it and it stays that way. A server you add yourself
starts with an unconstrained pool, and you point it at whichever filters you want under its Queue settings.

## Squad servers

One SLM instance can manage several squad servers. Click "Add Server" to start setting one up.

Each server uses one of three connection modes:

- **local** - SLM shares the box with the squad server. It reads `SquadGame.log` directly and dials RCON directly.
  Lowest latency for SLM's event processing. Needs a log file path and RCON details.
- **sftp** - SLM is remote. It tails the log file over SFTP, polling periodically, and dials RCON directly over the
  network. Works with PSG-hosted squad servers where you cannot run an agent. Needs SFTP details and RCON details.
- **server agent** - run the small [server agent](#server-agent) on the game host. It handles both the log stream
  and RCON, so SLM never holds the RCON password and never needs to reach the RCON port. Best when SLM runs
  somewhere other than the game host. Needs only a shared token here.

### Server agent

When you pick "server agent" mode, you can choose or generate a secret token for the agent to authenticate with. The
agent connects to SLM's normal url, the same `ORIGIN` you serve the app on, at the `/server-agent` path. Use `wss://`
if SLM is served over https, `ws://` over plain http.

The agent ([server-agent/agent](../server-agent/agent), a small rust program) runs next to the squad server. It
tails the server's `SquadGame.log` and streams new lines as they are written, and it proxies RCON: it holds the RCON
password itself, authenticates to the local RCON port, and tunnels the connection to SLM. So the RCON password stays
on the game host, and the RCON port never has to be exposed to SLM. The agent resumes on its own if the connection
drops.

The RCON proxy is opt-in. Supply `--rcon-host`, `--rcon-port` and `--rcon-password` to enable it, or omit all three
to run the agent logs-only.

There are two ways to run it.

#### Standalone binary

Download the binary for your platform from the
[releases page](https://github.com/Tactrigsds/squad-layer-manager/releases) (tags named `server-agent-v*`) and run
it as a service:

```sh
slm-server-agent --url wss://slm.example.com/server-agent --server-id <id> --token <token> --file /path/to/SquadGame.log \
  --rcon-host 127.0.0.1 --rcon-port 21114 --rcon-password <rcon-password>
```

#### Docker

Run the published image, `ghcr.io/tactrigsds/slm-server-agent:latest`, configured through env vars, mounting the
server's log directory read-only:

```sh
docker run -d --restart unless-stopped \
  -v /path/to/SquadGame/Saved/Logs:/logs:ro \
  -e SLM_URL=wss://slm.example.com/server-agent -e SLM_SERVER_ID=<id> -e SLM_TOKEN=<token> \
  -e SLM_LOG_PATH=/logs/SquadGame.log \
  -e SLM_RCON_HOST=<rcon-host> -e SLM_RCON_PORT=<rcon-port> -e SLM_RCON_PASSWORD=<rcon-password> \
  ghcr.io/tactrigsds/slm-server-agent:latest
```

The standalone binary and the docker image take the same settings, as either a flag or an env var:

| Flag              | Env var             | Required | Default | Description                                                              |
| ----------------- | ------------------- | -------- | ------- | ------------------------------------------------------------------------ |
| `--url`           | `SLM_URL`           | yes      |         | SLM websocket url, e.g. `wss://slm.example.com/server-agent`             |
| `--server-id`     | `SLM_SERVER_ID`     | yes      |         | Server id as configured in SLM                                           |
| `--token`         | `SLM_TOKEN`         | yes      |         | The server-agent token for that server                                   |
| `--file`          | `SLM_LOG_PATH`      | yes      |         | Path to `SquadGame.log`                                                  |
| `--rcon-host`     | `SLM_RCON_HOST`     | no\*     |         | Local RCON host to proxy (usually `127.0.0.1`)                           |
| `--rcon-port`     | `SLM_RCON_PORT`     | no\*     |         | Local RCON port                                                          |
| `--rcon-password` | `SLM_RCON_PASSWORD` | no\*     |         | RCON password (stays on the game host, never sent to SLM)                |
| `--reconnect-ms`  | `SLM_RECONNECT_MS`  | no       | `5000`  | Delay between reconnect attempts, in milliseconds                        |
| `--poll-ms`       | `SLM_POLL_MS`       | no       | `1000`  | How often to check the log for new data, in milliseconds                 |
| `--log-file`      | `SLM_AGENT_LOG`     | no       |         | Also append the agent's own logs to this file                            |
| `--insecure`      | `SLM_INSECURE=1`    | no       | off     | Do not verify the server's TLS certificate (self-signed / IP-only certs) |

\* The three `--rcon-*` options are all-or-nothing. Supply all three to enable the RCON proxy, or none to run
logs-only.

## Permissions

SLM has a role-based access control system. Roles are assigned to users to control their access to SLM's features.
Roles are non-hierarchical, and access to change other users' permissions is controlled by global settings grants.

### Role setup

Go to the Permissions & Roles section of the global settings. Three roles exist by default:

- `alladmins` - the features needed for day-to-day operations, like modifying the queue and managing players. Max
  timeout of 1h.
- `manager` - everything except RBAC, adding and removing squad servers, and seeing sensitive server connection
  details.
- `owner` - full administrative access.

### Assigning roles

Roles are granted per user. In a role's editor, add the Discord user ids or Discord role ids to grant it under
Assignments. Anyone matching gets the role's permissions.

A fresh install has no assignments yet, so the `SUPER_USERS` and `SUPER_ROLES` you set in `.env` are the bootstrap.
They hold every permission unconditionally until you assign real roles here, and are how you avoid locking yourself
out.

### Settings grants

Full settings access comes from a role's permissions, but a role can also be given narrower, path-scoped access
without it:

- **Global settings grants** - dotted setting paths the role may edit, e.g. `vote.voteDuration`, or `vote` for the
  whole section. Any grant also lets the role view global settings.
- **Server settings grants** - the same for a server's settings, optionally limited to specific servers. Sensitive
  connection details sit behind a separate write-sensitive permission and are never reachable through a path grant.

A `!...:write` denial in a role's permissions overrides its grants.

## Command triggers

A command is run by one of its triggers: the strings listed against it under Settings > In-game Commands. `/timeout`
and `/to` are two triggers for the same command, and typing either takes the command's arguments exactly as written.

A trigger can also pin some of those arguments. Give it an `args` template and it becomes a shortcut, which is what
command aliases used to be:

| Trigger   | Pinned args                                  | Typed in chat           | Runs                         |
| --------- | -------------------------------------------- | ----------------------- | ---------------------------- |
| `/to`     | (none)                                       | `/to Alice 2h spamming` | `/timeout Alice 2h spamming` |
| `/to2h`   | `{{arg1}} 2h {{rest2}}`                      | `/to2h Alice spamming`  | `/timeout Alice 2h spamming` |
| `/rules`  | `Read the rules`                             | `/rules`                | `/broadcast Read the rules`  |
| `/say`    | `{{rest}}`                                   | `/say back in 5`        | `/broadcast back in 5`       |
| `/warnsp` | `{{arg1}} {{^rest2}}spam{{/rest2}}{{rest2}}` | `/warnsp Alice`         | `/warn Alice spam`           |

**The numbers count the words the caller types, not the words of the command that ends up running.** `{{arg1}}` is
the first word typed after the trigger, `{{arg2}}` the second, and so on. `{{restN}}` is the Nth word typed onwards,
joined by spaces, and `{{rest}}` is all of them. Use `{{restN}}` for anything that can be more than one word, such
as a reason.

Pinned text sits outside that counting, which is what makes `{{arg1}} 2h {{rest2}}` read correctly. The caller never
types the duration, so nothing indexes it.

```
they type:   Alice      spamming badly
             {{arg1}}   {{rest2}}          <- the numbers count these words
it runs:     Alice  2h  spamming badly
                    ^^ pinned text, never typed, so no placeholder refers to it
```

Once a trigger has pinned arguments, the command's card in Settings > In-game Commands shows which placeholder fills
which argument (`{{arg1}} <player>  {{arg2}} <duration>  {{rest3}} <reason|message>`), including whether each one is
required under the current reason settings.

A word that is left out renders as nothing and its token drops out, which is what makes it optional: `/to2h Alice`
runs `/timeout Alice 2h` with no reason. `{{^arg2}}fallback{{/arg2}}` puts something in its place instead. Words the
template never mentions are ignored.

A pinned-argument template is not the same as writing `{{rest}}`. A placeholder stands for one word when the
arguments are worked out, so `{{rest}}` alone means "the player, and nothing else" rather than "everything as
typed". Leave the args off entirely for a plain trigger.

Every trigger string across every command shares one namespace, and two commands cannot claim the same one. A
trigger runs in its command's allowed chats, so pinning arguments cannot turn a public trigger into an admin
command. What it can do is let a public trigger pass a player's own words into a public command's free-text
argument, which is worth keeping in mind when writing one.

The commands page lists a command's shortcut triggers under its details, and searching for one finds the command it
runs. `!help` lists each shortcut on its own line, since it asks the caller for something different.

## Choosing between near misses

When an argument does not resolve but something close does, SLM asks instead of refusing. A mistyped player name, a
squad name that matches two squads, or a mistyped reason keyword comes back as a short list to pick from:

```
No player matches found for "alise"
1) Alice_The_Great
2) Alicia
Reply 1-2, or 0 to cancel
```

Reply with the number, in the same chat you typed the command in. The command then runs as if you had typed the
choice yourself, permission check included.

Mistype more than one argument and you are asked once per argument, in the order you typed them. Each question says
which one it is, and you can answer several at once by sending the numbers together: `1 2` answers the first two.

A question ends when you answer it, when you send `0` to cancel, when you run another command, or after 45 seconds.
Running another command discards the question and says so, which keeps a number typed much later from acting on a
command you have forgotten about.

While a question is open, a number you send answers it rather than casting a vote. Send `0` first if you meant to
vote. A number sent in a different chat is unaffected.

Nothing is ever picked for you. SLM asks even when only one thing is close, because an admin action against the
wrong player is what the question exists to prevent.

Arguments matched against a known list work this way: players, squads, teams, reasons, BattleMetrics flags, the
timed-out player `/cleartimeout` takes, `/help` sections, and the words of a layer request. An argument that is
simply malformed, such as a duration or a queue number, is still an error, since there is nothing to choose
between.
