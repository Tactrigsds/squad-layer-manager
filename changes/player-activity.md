---
audience: operators
kind: changed
---

Use the new _Player Activity_ setting under _Players & Balance_ to set how long a player can go without doing anything
before SLM counts them as idle.

The AFK Kicker follows SLM's idle rule on its idle gamemodes, so it no longer kicks an inactive player who is in a squad
or in a vehicle there. The kicker's `idleWindow` setting still decides how long a player stays idle before the kicker
acts. Plugins can read
the same rule from `slm/systems/player-activity` (plugin API 0.10.1).

After the upgrade, SLM counts the players of every past match in the background, newest first, for the chart's day and
week ranges. Until a match is counted, the chart notes how many in its range are still missing.
