---
audience: operators
kind: changed
---

The upgrade rewrites stored player death and wound events. It takes a few seconds per million events. An earlier version cannot read the rewritten events, so a downgrade drops them from the activity feed and history.

Plugin `PLAYER_DIED` and `PLAYER_WOUNDED` events name the `caused by` actor `damageSource` instead of `weapon`. `PLAYER_DIED` also records `deathVariant`, which is `killed` or `diedOfWounds`.
