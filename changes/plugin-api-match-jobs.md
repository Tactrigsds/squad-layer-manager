---
audience: operators
kind: added
---

Plugin API 0.22.2 lets a plugin time jobs from a match and derive its jobs from its config. `afterMatchStart` and `afterMatchEnd` in `slm/plugin/schedule` run a server job a set time after the server's match starts or ends. The server module's `jobs` export can be a function of the config, called again on each save, and a job's `label` and `description` name and describe it on the settings page. `execute` in `slm/systems/squad-rcon` runs a raw RCON command and records it in the audit log. Plugins built for 0.22.1 keep working.
