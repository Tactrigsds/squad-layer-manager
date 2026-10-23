# Server console

The server console displays a Squad server's raw traffic as SLM receives it, and runs RCON commands on the server. Use
the console when the dashboard does not match what is happening on the server.

Open it from **Server Actions -> Server Console**.

![the console, showing a switch-request trade as RCON commands and log lines](../../images/operations/server_console.png)

## Channels

- **RCON**: RCON commands and the server's responses.
- **Logs**: the server's log lines.
- **Player Commands**: every chat message.
- **Connection**: SLM's attempts to connect to the server, with the error behind each failure.

## Running commands

Type an RCON command into the box at the bottom of the RCON tab and press Enter. Press Up and Down to step through
earlier commands. SLM records every command run from the console in the audit log and in the server's activity feed.

## Permissions

| Permission                   | Grants                                        |
| ---------------------------- | --------------------------------------------- |
| `squad-server:view-console`  | Reading the console                           |
| `squad-server:write-console` | Reading the console and running RCON commands |

Raw log lines carry player IPs, Steam and EOS ids, and admin chat. Grant `squad-server:view-console` only to people who
debug the server.

A command run from the console bypasses every other SLM permission. Grant `squad-server:write-console` only to people
who could be trusted with the RCON password.

No role holds either permission until an admin grants it.
