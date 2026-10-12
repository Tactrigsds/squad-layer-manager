---
audience: operators
kind: breaking
---

The plugin API moved to 0.13. Queue items added from a saved rotation differ from other queue items.

A note copied from a rotation has no `author`, and its `fromRotation` names the rotation. A tag id can be
`from-rotation:<rotationId>`, which names no configured tag. A new item passed to `add` may carry notes, but only notes
with no `author` and a `fromRotation`. A plugin that reads `note.author` or looks tag ids up in the layer tags must
handle both cases.
