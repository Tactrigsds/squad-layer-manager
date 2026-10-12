---
audience: operators
kind: added
---

Plugins can read, create, clone, update and delete rotations through `slm/systems/rotation`.

A rotation a plugin creates is owned by the plugin, and the _Rotations_ page names the plugin as its owner. Admins with
`rotations:write-all` can still edit and delete it. A plugin can make an admin the owner instead. The audit log records
every rotation change a plugin makes against the plugin. A plugin cannot replace a rotation's layers while an admin has
unsaved edits to them open.
