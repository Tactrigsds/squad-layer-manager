---
audience: operators
kind: added
---

Plugin API 0.22.1 lets a plugin post rich Discord messages and read a past match's events. `sendMessage` in `slm/systems/discord` posts embeds and attached files, `getMatchEvents` in `slm/systems/match-history` returns a match's activity feed, `listServers` in `slm/systems/settings` lists every server with its name and whether it is enabled or a sandbox, and the new `slm/server/svg-raster` draws an SVG to a PNG. Plugins built for 0.22.0 keep working.
