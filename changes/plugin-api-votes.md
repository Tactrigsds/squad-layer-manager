---
audience: operators
kind: changed
---

The plugin API is version 0.24, and plugins can start votes. A plugin built for 0.23 does not load until its
`apiVersion` is raised to `^0.24`.

`slm/systems/vote` starts the layer vote of a queue item, starts a simple vote between text choices, and follows the
simple vote's tally to its result. The version moved because a vote's config gained the text shown for each choice,
and the per-server ctx gained the vote state.
