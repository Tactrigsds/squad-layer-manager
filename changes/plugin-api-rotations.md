---
audience: operators
kind: added
---

Plugins can search, read, create, clone, update and delete rotations through `slm/systems/rotation`, and add a
rotation to their server's queue the way _Add Rotation_ does. A search returns one page of rotations at a time, without
their layers. A plugin's settings can include a rotation tag picker, and a plugin can create layer and rotation tags.
When a plugin adds a rotation to the queue, it can clear chosen queue items in the same edit.

A rotation a plugin creates is owned by the plugin, and the _Rotations_ page names the plugin as its owner. Admins with
`rotations:write-all` can still edit and delete it. A plugin can make an admin the owner instead. The audit log records
every rotation change a plugin makes against the plugin. A plugin cannot replace a rotation's layers while an admin has
unsaved edits to them open.
