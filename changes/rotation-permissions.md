---
audience: operators
kind: added
---

New permissions control rotations: `rotations:create` and `rotations:write-all`.

The upgrade grants `rotations:create` to every role holding `filters:create`, and `rotations:write-all` to every role
holding `filters:write-all`. Whoever created a rotation can edit it, along with the users and roles added to it as
contributors.
