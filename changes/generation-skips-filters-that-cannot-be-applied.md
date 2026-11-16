---
audience: users
kind: changed
---

A filter that cannot be applied no longer stops SLM from generating a layer. A filter cannot be applied when it names a column or value the current layer data does not have, or applies a filter that was deleted.

SLM now generates the next layer or vote from your server's other filters. SLM warns the admins in game, naming each filter it left out, and the activity feed records the generated layer with those filters. Before, SLM queued a fixed default layer instead. The next-layer warn that admins see also names each filter the next layer could not be checked against.

A layer request filter that cannot be applied is left out of new layer requests, and the reply names it. A request that applies such a filter itself is refused with a message saying the filter cannot be applied, instead of "No layers in the current pool match this request".
