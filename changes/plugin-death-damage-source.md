---
audience: operators
kind: changed
minor: true
---

Plugin `PLAYER_DIED` and `PLAYER_WOUNDED` events name the `caused by` actor `damageSource` instead of `weapon`. `PLAYER_DIED` also records `deathVariant`, which is `killed` or `diedOfWounds`.
