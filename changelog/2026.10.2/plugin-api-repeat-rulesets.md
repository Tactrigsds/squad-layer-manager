---
audience: operators
kind: added
---

Plugins can read, create, replace and delete repeat rulesets through `slm/systems/repeat-ruleset`, and choose which
repeat ruleset their server applies. A plugin cannot delete a repeat ruleset that a server or rotation still uses. The
audit log records every repeat ruleset change a plugin makes against the plugin.
