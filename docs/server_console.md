# Server console

The console is a live tail of what a squad server is saying and being told. It is available on every server,
including sandboxes. The dashboard shows what SLM believes is true. The console shows what went over the wire, which
is what you need when the two disagree.

Open it from **Server Actions -> Server Console**. It is a draggable window, so it can stay open beside the dashboard
while you reproduce something.

## Channels

There are three channels. Read them together (**All**) or one at a time.

- **RCON**: every command and response, in both directions. `rcon <-` is a command arriving at the game server,
  `rcon ->` is the server answering. The direction is always written from the server's point of view, even though
  SLM is at the other end, so a sandbox and a real server read the same way.
- **Logs**: the raw log lines as ingested, before parsing. Lines from every source (local file, SFTP poll, server
  agent, sandbox) appear here as SLM received them.
- **Player Commands**: what players typed, by channel and author.

## Hide noise

Hide noise is on by default. Traffic on a quiet server is mostly SLM asking the same few questions on a timer and
getting the same answers, plus a tick rate line every couple of seconds. With the box ticked the console hides:

- an rcon exchange whose response is identical to the last response to that same command, request included
- the `Server Tick Rate` heartbeat

The count beside the checkbox shows how many entries are hidden. Untick the box when you need to confirm that
nothing changed.

Responses are matched to commands by rcon request id. SLM keeps several commands in flight at once, and the server
answers them in whatever order it finishes. A response next to a command in the stream is not necessarily its answer.

## Permission

Reading a console requires `squad-server:view-console` on that server. It is separate from `squad-server:view`
because it discloses much more than the dashboard does: raw log lines carry player IPs, Steam and EOS ids, admin
chat and every admin action. Grant it to people who debug the server, not to everyone who can look at it.

The permission is new, so no role holds it until an admin grants it. Superusers have it, as they have everything.

## Read-only

The console cannot issue commands. An rcon prompt here would route around every other permission in the app
(`AdminBan`, `AdminKick`, changing the layer) and leave no app event behind, so the audit log would show a server
changing by itself. Take actions through the features that own them, which check permissions and record them.

## Retention

The console keeps a short backlog per server, in memory only, capped by both entry count and total bytes (see
`src/models/server-console.models.ts`). Opening a window mid-match shows that backlog and then the live tail. A
managed server restart drops it, because the traffic described a connection that no longer exists. Anything worth
keeping is already a server event or an app event.
