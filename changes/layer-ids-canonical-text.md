---
audience: operators
kind: breaking
---

Plugins must be updated for plugin API 0.20, which changes what a layer id is.

A layer id is now the layer's name and its two teams in the game's own words, such as
`Narva_RAAS_v1:USA+CombinedArms:RGF+CombinedArms`, wherever SLM stores one. While SLM runs, a layer its layer data
holds is a number instead, which only means that layer against the loaded layer data. A plugin that stores layer ids
in its own tables has to store `L.toLayerText(id)` and read them back with `L.fromStoredLayerText`. The
plugin guide's _Layer ids_ section describes both.

The upgrade needs no other step. SLM still reads every layer id it stored before, and rewrites the ones in match
history and the activity feed into the new form in the background a few minutes after it starts. Links to a layer
written with an old id still open that layer.
