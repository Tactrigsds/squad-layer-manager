---
audience: operators
kind: breaking
---

Repeat rules moved from each server's settings into rulesets in the global settings.

The upgrade migrates them automatically. Each server's `queue.mainPool.repeatRules` becomes a ruleset under the global
`rulesets` setting, named after the server, and the server's settings point at it with `queue.mainPool.rulesetId`.
Tutorial servers share one `slm-tutorial` ruleset.

Anything that writes `queue.mainPool.repeatRules` must write the server's ruleset instead. That covers scripts that
edit settings, settings YAML kept outside SLM, and plugins that read the rules from a server's settings.
