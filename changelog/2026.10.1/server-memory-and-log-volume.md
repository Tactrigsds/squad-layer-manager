---
audience: operators
kind: changed
---

SLM's memory use no longer grows with uptime. Several in-memory buffers and open browser connections kept everything they had ever handled until a restart.

The `RCON PACKET` and `emitted event` log lines are logged at `debug` instead of `info`, so production logs at the default level are much smaller.

SLM looks up a Discord user who has left your guild at most once every 10 minutes, so the warning for that lookup appears far less often. Editing or reordering Discord roles no longer makes SLM recheck every signed-in user's permissions.

Background BattleMetrics refreshes use at most 45 of the 60 requests a minute that BattleMetrics allows, so requests made by admins are not held behind them.

The upgrade drops six database indexes that no query reads and adds one for weapon filters on the history page. Expect the migration to take about half a second per million recorded events.
