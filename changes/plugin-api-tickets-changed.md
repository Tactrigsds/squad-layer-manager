---
audience: operators
kind: changed
minor: true
---

The plugin API is version 0.18, because the settings type plugins read gained the `tickets` command. A plugin built for
0.17 does not load until its `apiVersion` is raised to `^0.18`. Plugins also receive a `TICKETS_CHANGED` server event
each time either team's tickets change.
