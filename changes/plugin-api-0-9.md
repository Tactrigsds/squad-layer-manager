---
audience: operators
kind: breaking
---

The plugin API is version 0.9. A packed plugin that declares `^0.8` does not load until it is rebuilt against 0.9.

The built-in plugins are already updated. For a plugin of your own, set `apiVersion` to `^0.9` in its manifest and repack it with `pnpm plugin:pack`. No other change is needed: the player objects that `getPlayer`, `getTeams` and `checkPlayer` work with can carry `partyId` and `vehicle`, and `slm/lib/rxjs-ext` adds `bufferBurst`.
