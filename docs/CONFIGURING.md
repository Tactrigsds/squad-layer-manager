# Configuring SLM

This guide assumes that you already have a running instance of SLM. Go to [INSTALLING.md](INSTALLING.md) if you don't.

SLM is largely configured through the settings page.

Most of these settings aren't relevant yet, but we need to set a few things up first before SLM can be used on your server.

All settings are optionally editable via a built-in JSON editor.

## Squad Servers

Multiple squad servers can be hooked up to a single SLM instance. Click the "Add Server" button to start setting up a new server.

Each server uses one of three connection modes:

- local - assumes SLM shares the box with the squad server: it reads the `SquadGame.log` directly and dials RCON directly. Lowest latency for SLM's event processing. Needs a log file path and RCON details.
- sftp - SLM is remote: it tails the log file over SFTP (polling periodically) and dials RCON directly over the network. Works fine with PSG-hosted squad servers where you can't run an agent. Needs SFTP details and RCON details.
- server agent - Run the small [server agent](#server-agent) on the game host. It handles both the log stream and RCON, so SLM never holds the RCON password and never needs to reach the RCON port. Best when SLM runs somewhere other than the game host. Needs only a shared token here.

### Server Agent

When you pick the "server agent" mode, you can choose or generate a secret token for the agent to authenticate with. The agent connects to SLM's normal url (the same `ORIGIN` you serve the app on) at the `/server-agent` path - If SLM is served over https, use
`wss://`; over plain http, use `ws://`.

The agent ([server-agent/agent](../server-agent/agent), a small rust program) runs next to the squad server. It tails the server's `SquadGame.log` and streams new lines as they are written, and it proxies RCON: it holds the RCON password itself, authenticates to the local RCON port, and tunnels the connection to SLM. That way the RCON password stays on the game host and the RCON port never has to be exposed to SLM. It resumes on its own if the connection drops. There are three ways to run it.

The RCON proxy is opt-in: supply the agent with `--rcon-host` / `--rcon-port` / `--rcon-password` to enable it. Omit all three to run the agent logs-only.

#### Standalone binary

Download the binary for your platform from the
[releases page](https://github.com/Tactrigsds/squad-layer-manager/releases) (tags named `server-agent-v*`) and
run it as a service:

```sh
slm-server-agent --url wss://slm.example.com/server-agent --server-id <id> --token <token> --file /path/to/SquadGame.log \
  --rcon-host 127.0.0.1 --rcon-port 21114 --rcon-password <rcon-password>
```

#### Docker

Run the published image, `ghcr.io/tactrigsds/slm-server-agent:latest`, configured through env vars, mounting
the server's log directory read-only:

```sh
docker run -d --restart unless-stopped \
  -v /path/to/SquadGame/Saved/Logs:/logs:ro \
  -e SLM_URL=wss://slm.example.com/server-agent -e SLM_SERVER_ID=<id> -e SLM_TOKEN=<token> \
  -e SLM_LOG_PATH=/logs/SquadGame.log \
  -e SLM_RCON_HOST=<rcon-host> -e SLM_RCON_PORT=<rcon-port> -e SLM_RCON_PASSWORD=<rcon-password> \
  ghcr.io/tactrigsds/slm-server-agent:latest
```

Both the standalone binary and the Docker image take the same settings, as either a flag or an env var:

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

\* The three `--rcon-*` options are all-or-nothing: supply all three to enable the RCON proxy, or none to run logs-only.

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
