# Configuring SLM

This guide assumes that you already have a running instance of SLM. Go to [INSTALLING.md](INSTALLING.md) if you don't.

SLM is largely configured through the settings page.

Most of these settings aren't relevant yet, but we need to set a few things up first before SLM can be used on your server.

All settings are optionally editable via a built-in JSON editor.

## Squad Servers

Multiple squad servers can be hooked up to a single SLM instance. Click the "Add Server" button to start setting up a new server.

Doing so requires RCON connection details, and a log source.
There are 3 potential log sources:

- local file - this one assumes that you have your squad server's logs directly mounted to SLM's docker container. This option gives you the least latency for SLM's event processing.
- log agent - Run a small agent on your squad server's machine that streams log entries to SLM over a websocket. Best when SLM runs somewhere other than the game host. See below.
- sftp - SFTP connection to the server's log file. Will poll periodically for new log entries. Works fine with PSG-hosted squad servers where you can't run an agent.

### Log Agent

When you pick the "log agent" source, you can choose or generate a secret token for the log agent to authenticate with. The agent connects to SLM's normal url (the same `ORIGIN` you serve the app on) at the `/log-agent` path - If SLM is served over https, use
`wss://`; over plain http, use `ws://`.

The agent ([log-agent/agent](../log-agent/agent), a small rust program) tails the server's `SquadGame.log`
and streams new lines as they are written. It resumes on its own if the connection drops. There are three
ways to run it.

#### SquadJS plugin

If you already run SquadJS, drop [log-agent/squadjs-plugin.js](../log-agent/squadjs-plugin.js) into your
SquadJS plugins directory and add it to the `plugins` array in your SquadJS `config.json`. It downloads the
matching agent binary and launches it detached, so the agent keeps streaming even if SquadJS restarts or
crashes.

```json
{
	"plugin": "SLMLogAgent",
	"enabled": true,
	"url": "wss://slm.example.com/log-agent",
	"slmServerId": "<your-slm-server-id>",
	"token": "<log-receiver-token>"
}
```

| Option        | Required | Default              | Description                                                                     |
| ------------- | -------- | -------------------- | ------------------------------------------------------------------------------- |
| `url`         | yes      |                      | SLM log-agent websocket url, e.g. `wss://slm.example.com/log-agent`             |
| `slmServerId` | yes      |                      | This server's id as configured in SLM                                           |
| `token`       | yes      |                      | The log-receiver token for this server (SLM server settings, Log Source)        |
| `insecure`    | no       | `false`              | Skip TLS certificate verification (self-signed / IP-only certs)                 |
| `binaryPath`  | no       | download release     | Path to an existing `slm-log-agent` binary instead of downloading one           |
| `binDir`      | no       | OS temp dir          | Directory to cache the downloaded agent binary in                               |
| `pidFile`     | no       | per-server temp path | PID file used to detect an already-running agent                                |
| `logFile`     | no       | per-server temp path | File the agent appends its own logs to (shown in SquadJS at verbose level 1)    |
| `killOnExit`  | no       | `false`              | Kill the agent when the plugin unmounts (off, so it survives a SquadJS restart) |

#### Standalone binary

Download the binary for your platform from the
[releases page](https://github.com/Tactrigsds/squad-layer-manager/releases) (tags named `log-agent-v*`) and
run it as a service:

```sh
slm-log-agent --url wss://slm.example.com/log-agent --server-id <id> --token <token> --file /path/to/SquadGame.log
```

#### Docker

Run the published image, `ghcr.io/tactrigsds/slm-log-agent:latest`, configured through env vars, mounting
the server's log directory read-only:

```sh
docker run -d --restart unless-stopped \
  -v /path/to/SquadGame/Saved/Logs:/logs:ro \
  -e SLM_URL=wss://slm.example.com/log-agent -e SLM_SERVER_ID=<id> -e SLM_TOKEN=<token> \
  -e SLM_LOG_PATH=/logs/SquadGame.log \
  ghcr.io/tactrigsds/slm-log-agent:latest
```

Both the standalone binary and the Docker image take the same settings, as either a flag or an env var:

| Flag             | Env var            | Required | Default | Description                                                              |
| ---------------- | ------------------ | -------- | ------- | ------------------------------------------------------------------------ |
| `--url`          | `SLM_URL`          | yes      |         | SLM websocket url, e.g. `wss://slm.example.com/log-agent`                |
| `--server-id`    | `SLM_SERVER_ID`    | yes      |         | Server id as configured in SLM                                           |
| `--token`        | `SLM_TOKEN`        | yes      |         | The log-receiver token for that server                                   |
| `--file`         | `SLM_LOG_PATH`     | yes      |         | Path to `SquadGame.log`                                                  |
| `--reconnect-ms` | `SLM_RECONNECT_MS` | no       | `5000`  | Delay between reconnect attempts, in milliseconds                        |
| `--poll-ms`      | `SLM_POLL_MS`      | no       | `1000`  | How often to check the log for new data, in milliseconds                 |
| `--log-file`     | `SLM_AGENT_LOG`    | no       |         | Also append the agent's own logs to this file                            |
| `--insecure`     | `SLM_INSECURE=1`   | no       | off     | Do not verify the server's TLS certificate (self-signed / IP-only certs) |

## Permissions

SLM has a role-based access control system (RBAC). Roles can be assigned to users to control their access to SLM's features.
Roles are non-hierarchical - and access to change other users' permissions is controlled by "Global settings grants".

### Role Setup

Go to the Permissions & Roles section of the global settings. By default, there are 3 roles available: `alladmins`, `manager`, and `owner`.

- `alladmins` - Access for features necessary for day-to-day operations, like modifying the queue, managing players, etc. Max timeout of 1h.
- `manager` - Allows access to all settings except for RBAC, adding and removing squad servers, and seeing sensitive server connection details.
- `owner` - Full administrative access

### Assigning roles

Roles are granted per user. In a role's editor, add the Discord user ids or Discord role ids to grant it under Assignments; anyone matching gets the role's permissions. A fresh install has no assignments yet, so the `SUPER_USERS` and `SUPER_ROLES` you set in `.env` are the bootstrap: they hold every permission unconditionally until you assign real roles here, and are how you avoid locking yourself out.

### Settings grants

Full settings access comes from a role's permissions, but a role can also be given narrower, path-scoped access without it:

- **Global settings grants** - dotted setting paths the role may edit (e.g. `vote.voteDuration`, or `vote` for the whole section). Any grant also lets the role view global settings.
- **Server settings grants** - the same for a server's settings, optionally limited to specific servers. Sensitive connection details sit behind a separate write-sensitive permission and are never reachable through a path grant.

A `!...:write` denial in a role's permissions overrides its grants.
