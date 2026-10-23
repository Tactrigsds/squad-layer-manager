# Server agent

The server agent is a small program that runs on the game host, beside your Squad server. The agent sends the server's
log to SLM and relays SLM's RCON commands to the server. Use the server agent whenever SLM runs on a different machine
from the game host:

- The RCON password stays on the game host. SLM never receives it.
- The game host opens no extra port. The agent connects out to SLM.
- The connection to SLM is encrypted. Raw RCON is not.

A host such as PSG that cannot run the agent uses the _sftp_ connection mode instead. The agent reconnects by itself
when the connection drops.

## Setting up the server in SLM

1. Open the server's settings, and set its connection mode to _server agent_. See
   [Connecting the server](../configuring/servers.md#connecting-the-server).
2. Press _Generate_ beside the token field, then save. Copy the token with _Copy token_. The token works as a password
   for the server's agent, so store it with your other secrets. SLM refuses an agent while the server's token is still
   `dev`.
3. Note the server's id from the same settings.

The agent needs three values:

| Value     | Where it comes from                                                                                 |
| --------- | --------------------------------------------------------------------------------------------------- |
| URL       | SLM's `ORIGIN` with the path `/server-agent`, starting `wss://` for https or `ws://` for plain http |
| Server id | The server's settings in SLM                                                                        |
| Token     | Step 2                                                                                              |

## Running the agent

Run the agent as a service on the game host, as a standalone binary or with Docker. Both read the same settings, as
either flags or environment variables. The [options](#options) table lists every setting.

### Standalone binary

1. Download the binary for your platform from the
   [releases page](https://github.com/Tactrigsds/squad-layer-manager/releases). Server agent releases are tagged
   `server-agent-v*`.
2. Run the binary with your values:

```sh
slm-server-agent --url wss://slm.example.com/server-agent --server-id <id> --token <token> \
  --file /path/to/SquadGame.log \
  --rcon-host 127.0.0.1 --rcon-port 21114 --rcon-password <rcon-password>
```

### Docker

Run `ghcr.io/tactrigsds/slm-server-agent:latest`, with the server's log directory mounted read-only:

```sh
docker run -d --restart unless-stopped \
  -v /path/to/SquadGame/Saved/Logs:/logs:ro \
  -e SLM_URL=wss://slm.example.com/server-agent -e SLM_SERVER_ID=<id> -e SLM_TOKEN=<token> \
  -e SLM_LOG_PATH=/logs/SquadGame.log \
  -e SLM_RCON_HOST=<rcon-host> -e SLM_RCON_PORT=<rcon-port> -e SLM_RCON_PASSWORD=<rcon-password> \
  ghcr.io/tactrigsds/slm-server-agent:latest
```

## Options

| Flag              | Env var             | Required | Default | Description                                                          |
| ----------------- | ------------------- | -------- | ------- | -------------------------------------------------------------------- |
| `--url`           | `SLM_URL`           | yes      |         | SLM's server agent URL, such as `wss://slm.example.com/server-agent` |
| `--server-id`     | `SLM_SERVER_ID`     | yes      |         | The server's id in SLM                                               |
| `--token`         | `SLM_TOKEN`         | yes      |         | The server's agent token                                             |
| `--file`          | `SLM_LOG_PATH`      | yes      |         | Path to `SquadGame.log`                                              |
| `--rcon-host`     | `SLM_RCON_HOST`     | yes      |         | RCON host, usually `127.0.0.1`                                       |
| `--rcon-port`     | `SLM_RCON_PORT`     | yes      |         | RCON port                                                            |
| `--rcon-password` | `SLM_RCON_PASSWORD` | yes      |         | RCON password. The agent never sends it to SLM.                      |
| `--reconnect-ms`  | `SLM_RECONNECT_MS`  | no       | `5000`  | Delay between reconnect attempts, in milliseconds                    |
| `--poll-ms`       | `SLM_POLL_MS`       | no       | `1000`  | Interval between checks of the log for new lines, in milliseconds    |
| `--log-file`      | `SLM_AGENT_LOG`     | no       |         | A file to append the agent's own logs to                             |
| `--insecure`      | `SLM_INSECURE=1`    | no       | off     | Skip TLS certificate checks, for self-signed or IP-only certificates |

## Checking the connection

Open the [server console](server_console.md) from **Server Actions -> Server Console**. Once the agent connects, new log
lines appear on the _Logs_ tab as the match runs. The _Connection_ tab records each failed attempt and the reason for
it.
