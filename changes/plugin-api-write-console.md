---
audience: operators
kind: changed
minor: true
---

The plugin API is version 0.17, because the settings type plugins read gained the `squad-server:write-console`
permission. A plugin built for 0.16 does not load until its `apiVersion` is raised to `^0.17`.
