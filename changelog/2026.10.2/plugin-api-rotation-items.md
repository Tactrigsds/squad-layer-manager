---
audience: operators
kind: breaking
---

The plugin API is version 0.16. A packed plugin that declares `^0.13` does not load until it is rebuilt against 0.16.

The built-in plugins are already updated. For a plugin of your own, set `apiVersion` to `^0.16` in its manifest and
repack it with `pnpm plugin:pack`. Changes since 0.13:

- A note copied from a rotation has no `author`, and its `fromRotation` names the rotation. A plugin that reads
  `note.author` must handle a note without one.
- A tag id can be `from-rotation:<rotationId>`, which names no configured tag. A plugin that looks tag ids up in the
  layer tags must handle one it does not find.
- A new item passed to `add` may carry notes, but only notes with no `author` and a `fromRotation`.
