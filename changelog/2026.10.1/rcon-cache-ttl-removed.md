---
audience: operators
kind: removed
---

The _RCON Cache TTL_ server settings are removed. SLM polls each game server at the old defaults: the current and next layer every 5 seconds, server info every 10 seconds and the roster every 5 seconds.

The upgrade deletes the stored values of these settings and any comments on them. A role's server settings grant that named these settings alongside others keeps the others. A grant that named only these settings becomes a read grant on the same servers, so the role can still view the settings of those servers.
