---
audience: operators
kind: breaking
---

The plugin API is version 0.10. A packed plugin that declares `^0.8` or `^0.9` does not load until it is rebuilt against 0.10.

The built-in plugins are already updated. For a plugin of your own, set `apiVersion` to `^0.10` in its manifest and repack it with `pnpm plugin:pack`. Other changes in 0.10:

- `getServerInfo` and `getLayerStatus` in `slm/systems/squad-rcon` answer from SLM's cache, as `getTeams` does, instead of sending an RCON command on every call. A plugin that calls them often no longer adds RCON traffic.
- `getTeams`, `getServerInfo`, `getLayerStatus` and `getPlayer` take an optional `{ ttl }` in milliseconds, for an answer fresher than the cache. A `ttl` below `MIN_TTL_MS` (1 second) is raised to it.
- `teams$`, `serverInfo$` and `layerStatus$` push every new answer to a plugin, so a plugin no longer has to poll.
- The player objects that `getPlayer`, `getTeams` and `checkPlayer` work with can carry `partyId` and `vehicle`.
- `tryKickPlayers` in `slm/systems/squad-server` kicks players like `kickPlayers` and returns the players the game server kicked.
- `slm/lib/rxjs-ext` adds `bufferBurst`.
