---
audience: operators
kind: breaking
---

Plugins must be updated for plugin API 0.20, which changes what a layer id is. Update tt-slm-plugins along with SLM.

SLM now stores a layer id as the layer's name and its two teams in the game's own words, such as
`Narva_RAAS_v1:USA+CombinedArms:RGF+CombinedArms`. SLM rewrites the layer ids it stored before into this form: saved
queues and rotations as it starts, and match history and the activity feed in the background a few minutes later.
Links to a layer written with an old id still open that layer.

An older SLM cannot read the rewritten ids. Back up the database before upgrading, so a rollback can restore it.
