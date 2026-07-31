# Server agent

The server agent is a small program that runs on the game host, next to your squad server. It streams the server's
log lines to SLM and proxies RCON, so SLM does not need direct access to either.

Use it when SLM runs somewhere other than the game host. It is the recommended connection mode, because:

- The RCON password stays on the game host. The agent holds it, authenticates to the local RCON port itself, and
  tunnels the connection to SLM.
- The RCON port does not have to be reachable from SLM.
- The connection to SLM is encrypted. Raw RCON is not.

The agent tails the server's `SquadGame.log` and sends new lines as they are written. If the connection drops, the
agent reconnects on its own.

The source is at [server-agent/agent](../server-agent/agent). It is a small rust program.

## Setting up the server in SLM

Set the server's connection mode to _server agent_. See
[configuring.md](configuring.md#21-connecting-the-server) for where that setting lives.

Then choose or generate a secret token. The agent sends this token to authenticate, so treat it as a credential.

The agent needs three things from the server's connection settings:

- the _url_ SLM is served on. This is the same `ORIGIN` you serve the app on, with the path `/server-agent`. Use
  `wss://` if you serve SLM over https, and `ws://` over plain http.
- the _server id_, shown with the rest of the server's connection settings.
- the _token_ you just set.

## Running the agent

There are two ways to run the agent. Both take the same settings, as either a flag or an environment variable.

### Standalone binary

Download the binary for your platform from the
[releases page](https://github.com/Tactrigsds/squad-layer-manager/releases) (tags named `server-agent-v*`), then run
it as a service:

```sh
slm-server-agent --url wss://slm.example.com/server-agent --server-id <id> --token <token> --file /path/to/SquadGame.log \
  --rcon-host 127.0.0.1 --rcon-port 21114 --rcon-password <rcon-password>
```

### Docker

Run the published image, `ghcr.io/tactrigsds/slm-server-agent:latest`. Configure it with environment variables, and
mount the server's log directory read-only:

```sh
docker run -d --restart unless-stopped \
  -v /path/to/SquadGame/Saved/Logs:/logs:ro \
  -e SLM_URL=wss://slm.example.com/server-agent -e SLM_SERVER_ID=<id> -e SLM_TOKEN=<token> \
  -e SLM_LOG_PATH=/logs/SquadGame.log \
  -e SLM_RCON_HOST=<rcon-host> -e SLM_RCON_PORT=<rcon-port> -e SLM_RCON_PASSWORD=<rcon-password> \
  ghcr.io/tactrigsds/slm-server-agent:latest
```

## Options

| Flag              | Env var             | Required | Default | Description                                                              |
| ----------------- | ------------------- | -------- | ------- | ------------------------------------------------------------------------ |
| `--url`           | `SLM_URL`           | yes      |         | SLM websocket url, e.g. `wss://slm.example.com/server-agent`             |
| `--server-id`     | `SLM_SERVER_ID`     | yes      |         | Server id as configured in SLM                                           |
| `--token`         | `SLM_TOKEN`         | yes      |         | The server-agent token for that server                                   |
| `--file`          | `SLM_LOG_PATH`      | yes      |         | Path to `SquadGame.log`                                                  |
| `--rcon-host`     | `SLM_RCON_HOST`     | yes\*    |         | Local RCON host to proxy (usually `127.0.0.1`)                           |
| `--rcon-port`     | `SLM_RCON_PORT`     | yes\*    |         | Local RCON port                                                          |
| `--rcon-password` | `SLM_RCON_PASSWORD` | yes\*    |         | RCON password (stays on the game host, never sent to SLM)                |
| `--reconnect-ms`  | `SLM_RECONNECT_MS`  | no       | `5000`  | Delay between reconnect attempts, in milliseconds                        |
| `--poll-ms`       | `SLM_POLL_MS`       | no       | `1000`  | How often to check the log for new data, in milliseconds                 |
| `--log-file`      | `SLM_AGENT_LOG`     | no       |         | Also append the agent's own logs to this file                            |
| `--insecure`      | `SLM_INSECURE=1`    | no       | off     | Do not verify the server's TLS certificate (self-signed / IP-only certs) |

\* See below.

## The RCON proxy

Supply `--rcon-host`, `--rcon-port` and `--rcon-password` to turn on the proxy. The three options are all or
nothing. If you supply some of them but not all, the agent refuses to start rather than run without the proxy you
asked for.

The proxy is required. An agent tells SLM which of the two data sources, the log and RCON, it can supply, and SLM
rejects an agent that does not supply both. A server in agent mode has no other route to the game server: SLM holds
no RCON details for it and reads no log file of its own, so an agent that carries only one of the two leaves the
other permanently dead.

An agent that is rejected says so in its own log, with what it supplied and what to add. It keeps retrying, so
fixing the settings on either end is enough to bring it up. Nothing streams in the meantime.

## Versions

Agent 0.3.0 is where the agent started declaring its data sources, so it needs an SLM new enough to read that.
Upgrade SLM first, then the agents. An older SLM rejects a 0.3.0 agent as having a bad token, whatever the token
is, and the agent says so when it reports the rejection.

## Checking that it works

The [server console](server_console.md) shows the log lines and the RCON traffic as SLM receives them. If the agent
is connected and the log path is right, new lines appear there as the match runs.
