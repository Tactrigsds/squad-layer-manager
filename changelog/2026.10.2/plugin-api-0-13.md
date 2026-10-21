---
audience: operators
kind: breaking
---

A packed plugin of your own that declares `^0.12` does not load until it is rebuilt against plugin API 0.13.

The built-in plugins are already updated. For a plugin of your own, set `apiVersion` to `^0.13` in its manifest and repack it with `pnpm plugin:pack`. Changes since 0.12:

- Filters gain `missExemption`, a filter node or null. Layers that match the node do not show the filter's miss indicator, and null exempts no layer. `Filters.create` exempts seeding and training layers when `missExemption` is left out.
