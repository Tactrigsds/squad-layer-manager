---
audience: operators
kind: changed
---

A new permission, `battlemetrics:write-notes`, controls who can add BattleMetrics notes.

The upgrade grants `battlemetrics:write-notes` to every role that has `battlemetrics:write-flags`, and denies it to
every role that denies `battlemetrics:write-flags`. Remove `battlemetrics:write-notes` from a role to stop that role
adding notes without affecting its flags.
