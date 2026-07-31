# Configuring SLM

This guide assumes you already have a running instance of SLM. See [installing.md](installing.md) if you do not.

SLM is configured mostly through the settings page. Most of those settings are not relevant yet, but a few things
have to be set up before SLM can be used on your server.

Navigate to the settings page in the header:

![settings](configuring_screenshots/settings_nav.png)

Every setting can also be edited through a built-in JSON editor.

Settings can be navigated via the table of contents on the left:

![toc](configuring_screenshots/toc.png)

## Admin Lists

SLM is able to parse the standard adminlist format that can be found in Admins.cfg. Set it up to point to a mounted file or a version hosted remotely via sftp or http(s).
By default, SLM considers players with the role `canseeadminchat` to be admins. If this isn't the case, change the setting below:
![adminlist](configuring_screenshots/adminlist.png)

Groups that you have configured in the adminlist can be used in a number of ways, including as [SLM role assignments](<>), and as means of [grouping players on the teams panel](<>).

Also by default, admins are given a "role assignment" that allows them to do things like manage players, the layer queue, and a few other things. We will cover that later [link](permissions)
You can include one or several adminlists as needed, in case you have multiple servers, each with their own adminlist.

Adminlists can include steamIds and eosIds as the identifiers for players interchangeably.

## Adding your server

One SLM instance can manage several squad servers.

Side note:
There will be a "Sandbox" server on a fresh install of SLM. This attaches to an "emulated" squad server which does its best to mimic how a real squad server behaves for the purposes of SLM.

Click "Add Server" to start setting one up:
![add_managed_server](configuring_screenshots/add_managed_server.png)

### Connecting the Server

Each server uses one of three connection modes:

- **local** - SLM shares the box with the squad server. It reads `SquadGame.log` directly and dials RCON directly.
  Lowest latency for SLM's event processing. Needs a log file path and RCON details.
- **sftp** - SLM is remote. It tails the log file over SFTP, polling periodically, and dials RCON directly over the
  network. Works with PSG-hosted squad servers where you cannot run an agent. Needs SFTP details and RCON details.
- **server agent (RECOMMENDED)** - run the small [server agent](#server-agent) on the game host. It handles both the log stream
  and RCON, so SLM never holds the RCON password and never needs to reach the RCON port. Best when SLM runs
  somewhere other than the game host. Needs only a shared token here, and unlike raw RCON, the connection is encrypted.

#### 1.1.1 Server agent

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

##### Standalone binary

Download the binary for your platform from the
[releases page](https://github.com/Tactrigsds/squad-layer-manager/releases) (tags named `server-agent-v*`) and run
it as a service:

```sh
slm-server-agent --url wss://slm.example.com/server-agent --server-id <id> --token <token> --file /path/to/SquadGame.log \
  --rcon-host 127.0.0.1 --rcon-port 21114 --rcon-password <rcon-password>
```

##### Docker

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

### Server adminlists

Select which of your [configured adminlists](<>) you want to apply for this server.

## Permissions

SLM has a role-based access control(RBAC) system. Roles group users in to different levels of access, with each role having a configurable set of permissions.
Some of these permissions are global, but many can be scoped to a specific squad server.

Unlike Discord roles, SLM roles are non-hierarchical. Access to change other users' permissions is controlled by global settings grants.

### Super Users

A fresh install has no assignments yet, so the `SUPER_USERS` and `SUPER_ROLES` you set in `.env` are the bootstrap.

They hold every permission unconditionally until you assign real roles here, and are how you avoid locking yourself
out:
![super_users](./configuring_screenshots/super_users.png)

### Role setup

Go to the Permissions & Roles section of the global settings. Three roles exist by default:

- `alladmins` - the features needed for day-to-day operations, like modifying the queue and managing players. Max
  timeout of 1h.
- `manager` - everything except RBAC, adding and removing squad servers, and seeing sensitive server connection
  details.
- `owner` - full administrative access.

### Assigning Permissions to Roles

Full settings access comes from a role's permissions, but a role can also be given narrower, path-scoped access
without it:

- **Global settings grants** - dotted setting paths the role may edit, e.g. `vote.voteDuration`, or `vote` for the
  whole section. Any grant also lets the role view global settings.
- **Server settings grants** - the same for a server's settings, optionally limited to specific servers. Sensitive
  connection details sit behind a separate write-sensitive permission and are never reachable through a path grant.

A `!...:write` denial in a role's permissions overrides its grants.

### Assigning roles

Roles can be assigned to both "users" (Who access settings via the queue, and are authorized via their discord account) and "players", who are ingame and are using the builtin commands. Users may choose to link their discord account to their in-game account so that the permissions that they get from both are combined for all actions. This is generally optional, and only needed for users who have elevated permissions on their user account that they want to use ingame.

The sources for ingame role assignments apply to ingame players:

- **Adminlist roles** - Roles granted by the adminlist(s) you have configured for this server.
- **Adminlist admin status** - Roles granted to players that are admins according to the configured rules for the relevant adminlist source.

You can also assign roles to users individually, their known discord roles, or for every member of a discord server.

### Testing assigned Permissions

Every user has the ability to see what permissions they have via the permissions info dialog:
![permissions_info_item](configuring_screenshots/permissions_info_item.png)
![permissions_info_dialog](configuring_screenshots/permissions_info_dialog.png)

Permissions and their traced roles can be grouped by role or by permission.

Clicking "Simulate Permissions" will allow you to check/uncheck different roles to see how different features in the UI behave as a result. Note that this is an in-browser simulation only, and any actions which aren't gated in the UI will still be checked with your actual permissions.
![simulate_permissions_1](configuring_screenshots/simulate_permissions_1.png)
![simulate_permissions_2](configuring_screenshots/simulate_permissions_2.png)

## Warns, Broadcasts, and Admin Actions

It's possible to configure a set of messages to display to users in various contexts such as admin-triggered warnings, kicks, broadcasts, etc through the Admin Actions & Reasons Section.

Reasons such as teamkilling, spamming, soloing, etc can be configured here. Their texts are set per "action", where an action may be a warn, broadcast, kick, timeout, etc.
![admin_action_reasons](configuring_screenshots/admin_action_reasons.png)

It's possible to template the messages via the templating language [mustache](https://mustache.github.io/mustache.5.html), as well as to define reusable message variables, which can be used across multiple snippets, or even included in other message variables.

Actions can optionally **require** a reason to be used:
![actions_requiring_reason](configuring_screenshots/actions_requiring_reason.png)
A freeform reason may still be entered by the user instead of one of the preconfigured reasons.

The result of this is that admins can use the ingame `/warn`, `/broadcast`, `/kick`, `/timeout`, and other commands with those preconfigured reasons. as long as there is text configured for the associated action. In other words, if there is no text configured for the kick action, then you cannot kick players with that reason.

![warn_details](configuring_screenshots/warn_details.png)
Reasons are also selectable when performing actions via the gui:
![kick_dialog](configuring_screenshots/kick_dialog.png)
![kick_text_insert](configuring_screenshots/kick_text_insert.png)

## Ingame Commands

SLM includes a large suite of ingame commands. For documentation on these commands and their usage, see the commands page in your SLM install:
![commands_page](configuring_screenshots/commands_page.png)

### Command Prefixes

By default, all commands are prefixed with `/`.
You can change this by modifying or adding prefixes via the "Allowed Prefixes" setting:
![command_prefixes](configuring_screenshots/command_prefixes.png)
If you change one of the existing prefixes, all commands with that prefix(or more precisely, triggers with that prefix. see below) will be automatically updated to your new chosen prefix.

<aside>It's recommended to pick a new prefix that doesn't conflict with your existing existing suite of commands, as some commands behave slightly differently than their typeical squadjs counterparts, which will confuse users. Instead, disable the old commands commands with a message directing users to the slm alternative.</aside>

### Command Triggers

An ingame command is run by one of its triggers: the strings listed against it under Settings > In-game Commands. `/timeout`
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

## Player Groupings

Player "groupings", are intended to help categorize players for administrative and balance purposes.

For example, here is TacTrig's grouping configuration for balance purposes:
![player_groupings_balance](configuring_screenshots/player_groupings_balance.png)

You can map battlemetrics player flags, adminlist groups[link](<>), player username regexes(which will include the player's configured tags), and even discord roles if you take the time to link the player's steam account to their discord account.

<aside>
At the moment maintaining discord->steam account links is a very manual process. In the future SLM will include a REST api to allow external tools to manage steam account links.
</aside>

Earlier group assignments take precedence over later ones.

The result of doing this is that grouped players' usernames are color-coded wherever they appear in the SLM interface:
![color_coded_usernames](configuring_screenshots/color_coded_usernames.png)

A breakdown of the population of players under each grouping mode will now be visible in the stats panel:
![teams_breakdown](configuring_screenshots/teams_breakdown.png)

## Player Flagging

It's possible to apply battlemetrics flags to players from ingame via the `/flag` command, or via the SLM interface.

![flag_command](configuring_screenshots/flag_command.png)
![flag_gui](configuring_screenshots/flag_gui.png)

Users can optionally include a reason for their flag, which will be rendered as a note. For now, this note is freeform text and is not associated with admin action reasons, though this may be changed in the future.

In order to require that a particular flag is applied with a reason, use the `playerFlagsRequiringNote` setting:

![player_flags_requiring_note](configuring_screenshots/player_flags_requiring_note.png)
![player_flags_requiring_note_enforced](configuring_screenshots/player_flags_requiring_note_enforced.png)

It's worth noting that flags that are set through the battlemetrics interface may take a while to be picked up by SLM's UI. This is because SLM aggressively caches battlemetrics data to avoid hitting their rate-limits. You can purge the cache for a particular player with the "refresh" button:
![flags_refresh](configuring_screenshots/flags_refresh.png)
Flags are also automatically refreshed when they're modified via SLM.

## Layers Table

### Default Displayed Columns

It's possible to configure the layers table to by default display additional information about each layer, and provide additional filtering options:

Configure the columns on the layer table in the layer select menu (Explore layers diaolog, Add layers dialog, etc):
![layer_table_columns](configuring_screenshots/layer_table_columns.png)

### Randomization

It's also possible to fully configure how the randomization is weighted for the layer select menu, and the layer autogen which occurs when the queue runs out of layers.

The procedure for layer autogeneration is that it proceeds down a configurable "pick order" of different attributes of a layer:
![layer_weights_pick_order](configuring_screenshots/layer_weights_pick_order.png)

For each attribute, a random selection is made, with the probability weighted based on the configured weights for that attribute:
![layer_weights_maps](configuring_screenshots/layer_weights_maps.png)

It continues to iterate through the pick order until only a single layer remains, or until the pick order is exhausted, in which case it selects a remaining layer at random.

Keep in mind that for each pick, values which do not have any layers given any background filtering and previously chosen attributes will never be chosen. This means that, in practice, the chosen weights do not map cleanly to expected probabilities.
