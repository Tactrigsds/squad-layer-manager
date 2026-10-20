---
audience: operators
kind: breaking
---

The plugin API is version 0.19. A plugin built for an earlier version does not load until its `apiVersion` is raised
to `^0.19` and it is repacked with `pnpm plugin:pack`.

The built-in plugins are already updated. Changes since 0.18:

- The layer naming functions moved from `slm/lib/display-helpers` to `slm/models/display-helpers`. Change a plugin's
  imports to the new specifier. The functions are unchanged.
