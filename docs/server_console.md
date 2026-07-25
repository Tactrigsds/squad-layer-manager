# Server console

The console is a live tail of what a squad server is saying and being told, on any server rather than only a
sandbox. It answers the question the dashboard cannot: not "what does SLM think is true" but "what actually went
over the wire", which is what you need when the two disagree.

Open it from **Server Actions -> Server Console**. It is a draggable window, so it can sit open beside the
dashboard while you reproduce something.

## Channels

Three, because they answer different questions. They can be read together (**All**) or one at a time.

- **RCON** -- every command and response, in both directions. `rcon <-` is a command arriving at the game server,
  `rcon ->` is the server answering. The direction is always written from the _server's_ point of view, even
  though SLM is standing at the other end, so a sandbox and a real server read the same way.
- **Logs** -- the raw log lines as ingested, before parsing. Whatever the source (local file, SFTP poll, server
  agent, sandbox), the console tails the point they all funnel through, so it shows what SLM actually received
  rather than what a particular source happened to produce.
- **Player Commands** -- what players typed, by channel and author.

## Hide noise

On by default. A quiet server is mostly SLM asking the same handful of questions on a timer and getting the same
answers, plus a tick rate line every couple of seconds. With the box ticked the console drops:

- an rcon exchange whose response is identical to the last response _to that same command_, request included; and
- the `Server Tick Rate` heartbeat.

The count beside the checkbox is how many entries are being withheld, so the filter never silently swallows
something. Untick it when "nothing changed" is the thing you are trying to establish.

Responses are matched to commands by rcon request id, not by position. SLM keeps several commands in flight at
once and the server answers them in whatever order it finishes, so adjacency in the stream is not correlation.

## Permission

Reading a console requires `squad-server:view-console` on that server. It is separate from `squad-server:view`
because it discloses considerably more than the dashboard does: raw log lines carry player IPs, Steam and EOS ids,
admin chat and every admin action. Grant it to people who debug the server, not to everyone who can look at it.

The permission is new, so no role holds it until an admin grants it. Superusers have it, as they have everything.

## Read-only

The console cannot issue commands, deliberately. An rcon prompt here would route around every other permission in
the app -- `AdminBan`, `AdminKick`, changing the layer -- and leave no app event behind, so the audit log would
show a server changing by itself. Actions belong to the features that own them, where they are permissioned and
recorded.

## Retention

Memory only, and short: a per-server ring buffer capped by both entry count and total bytes (see
`src/models/server-console.models.ts`). Opening a window mid-match gets you that backlog and then the live tail. A
slice restart drops it, because the traffic described a connection that no longer exists. Anything worth keeping
is already a server event or an app event.
