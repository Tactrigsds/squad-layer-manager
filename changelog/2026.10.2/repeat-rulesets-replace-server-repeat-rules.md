---
audience: operators
kind: breaking
---

A script, settings YAML or plugin that reads or writes `queue.mainPool.repeatRules` must use the server's repeat ruleset
instead. Repeat rules moved from each server's settings into repeat rulesets in the global settings.

The upgrade migrates the repeat rules automatically. Each server's `queue.mainPool.repeatRules` becomes a repeat
ruleset under the global `repeatRulesets` setting, named after the server, and the server's settings point at it with
`queue.mainPool.repeatRulesetId`. Tutorial servers share one `slm-tutorial` repeat ruleset.
