---
audience: operators
kind: breaking
---

A plugin of your own that reads or writes SLM's database through `ctx.db()` must move to `slm/server/db`, which runs every statement synchronously. `ctx.db()` and `runTransaction` are removed, and plugin API 0.21 refuses a plugin built for 0.20.

The plugin guide's "Reading and writing your tables" section describes the new calls. The tt-slm-plugins set ships an updated release alongside this one.
