# Integrations and hosting

Admins reach SLM in game as well as from the dashboard, and SLM connects to Discord, BattleMetrics and Steam. Roles
decide what each admin may do, plugins extend SLM, and SLM is self-hosted.

## In-game commands

Admins can access many SLM features in game through chat commands: votes, swaps, warns, kicks, timeouts, broadcasts,
flags and layer requests. A _trigger_ is the word typed in chat to run a command. Add your own triggers for any command,
including shortcuts with arguments filled in, such as `/to2h` for a two-hour timeout. See
[command_triggers.md](../guide/configuring/command_triggers.md).

The _Commands_ page in your install lists every command and how to use each one.

![the commands page](../images/configuring/commands_page.png)

## Integrations

### Discord

Users sign in with their Discord account. Grant SLM permissions to a Discord role, a Discord user or every member of
your server. Use your server's emoji to mark layers in the queue. Post a link to a selection of events from the
[activity feed or history page](player_management.md#activity-and-history) in Discord, and SLM replies with the events
attached as a text file.

### BattleMetrics

SLM reads your organization's player flags and notes from BattleMetrics. Flag a player and leave a note from the
dashboard or in game, without opening BattleMetrics. A grouping mode can also sort players into groups by flag, for
balance.

### Steam and Squad Browser

SLM looks up the link that joins your server, through the Squad Browser API or through Steam. The dashboard then shows a
join button. Use it to open your server in Squad.

## Permissions

A role grants a set of permissions, scoped to every server or to named ones. Assign roles to Discord users and roles,
to the admins of an admin list, or to the members of an admin list group. Roles can cap what their members may do,
such as the longest timeout or how many layers they may request.

![the admins role in the Permissions & Roles settings](../images/features/permissions.png)

Use _Simulate Permissions_ to preview the app with a different set of roles. See
[Permissions and users](../guide/configuring/permissions.md).

## Plugins

Plugins add commands, settings and behaviour to SLM. Install a plugin from the URL its author provides, then configure
and start the plugin on the settings page. SLM ships with three:

| Plugin           | What it does                                                              |
| ---------------- | ------------------------------------------------------------------------- |
| AFK Kicker       | Kicks AFK players when people are waiting in the queue, longest AFK first |
| Balance Triggers | Watches recent match outcomes and warns admins when they look one-sided   |
| Teamkill Warns   | Warns players when they have been teamkilled                              |

To write your own, see [writing_plugins.md](../developers/writing_plugins.md).

## Self-hosting

SLM ships as one Docker image, with its database stored in a file beside it. An install script sets up the compose
file and config, and SLM migrates its own database on upgrade. See [installing.md](../installing.md).

The compose file also includes an optional observability stack: Grafana, an OpenTelemetry collector and VictoriaMetrics.
Its preconfigured dashboards chart SLM's metrics, logs and traces, such as RCON traffic and failures, log ingestion and
the connection state of each server. See [installing.md](../installing.md#9-telemetry).

![a Grafana dashboard of RCON and log traffic](../images/features/grafana_dashboard.png)

- **Many servers.** One install manages any number of Squad servers. Connect each one through its log file on disk,
  over SFTP for hosted servers, or through the [server agent](../guide/operations/server_agent.md), which keeps your RCON password on the
  game host.
- **Sandbox server.** A fresh install starts with an emulated Squad server, for learning SLM and testing settings
  without touching real players. See [sandbox_servers.md](../guide/operations/sandbox_servers.md).
- **Backups.** SLM backs up its database before every upgrade, and on a schedule if one is set, and can upload the
  backups over SFTP. See [backups.md](../guide/operations/backups.md).
- **Server console.** Read the RCON traffic and log lines exactly as SLM receives them, to find whether a problem is
  in the connection or in SLM. See [server_console.md](../guide/operations/server_console.md).
- **Monitoring.** The compose file runs Grafana with dashboards for each server's player count and join queue.
- **Mods.** SLM's layer catalog covers vanilla Squad and several popular mods. See
  [Mod support](layer_selection.md#mod-support).

## Learning SLM

Two guided tutorials teach the layer queue and player management on a sandbox server. Open _Tutorials_ from the nav
bar. See [server_dashboard.md](../guide/server_dashboard.md).
