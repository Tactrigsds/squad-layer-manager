# afk-kicker

Kicks AFK players when people are waiting to join, longest AFK first.

## Who counts as AFK

It depends on the gamemode of the current layer.

On the **Idle gamemodes** (Seed and Training by default), a player is AFK when they have not done anything for
longer than **Idle window** (15 minutes by default). Chat, kills, deaths, squad changes, kit changes and admin
camera count. Moving around does not, because the server never reports it. Being out of a squad does not count,
because players often do not join one while seeding.

On every other gamemode, a player is AFK when they have been out of a squad for longer than **Squadless window**
(5 minutes by default).

A player who has just joined counts as active. So does everyone on the server when a new match starts, or when SLM
starts.

## When it kicks

Every five seconds it works out how many players have to go. It does nothing between the end of a match and the start
of the next one.

```
waiting in the queue - free slots - Target queue
```

Free slots do not include reserved slots. With **Target queue** at 0 it kicks one AFK player for each player
waiting. At 3 it leaves three waiting. At -2 it kicks until two slots are open, even with nobody waiting.

A kick counts as a free slot for 30 seconds, while the queued player loads in. So it does not kick twice for the
same player.

The game server refuses to kick some players, such as Squad's developers. The AFK kicker skips a refused player
until they leave the server, and does not warn them again.

## Warnings

While the server is full, every AFK player is warned once per **Warn interval**. A player about to be kicked gets
the final warning five seconds beforehand. If they stop being AFK in that time, they stay.

Kicks appear in the server's event feed, attributed to the plugin.

## Settings

It runs only on the servers listed in **Enabled servers**. Every other setting applies to all of them.
