---
audience: operators
kind: breaking
---

A plugin that creates filters, or reads a filter's owner, needs a code change for plugin API 0.11. A filter's `owner` is now `{ type: 'slm-user', userId }`, `{ type: 'plugin', pluginId }` or `{ type: 'system' }` instead of a discord user id.

`create` in `slm/systems/filter-entity` makes the calling plugin the filter's owner. To keep an admin as the owner, pass `owner: { type: 'slm-user', userId }`.

The upgrade hands SLM's starting filters, and any filter whose owner was removed from SLM, to SLM itself. Filters an admin owns stay theirs.
