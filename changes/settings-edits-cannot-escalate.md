---
audience: operators
kind: fixed
---

A user allowed to edit the permissions config or the admin lists could grant themselves any permission. SLM now refuses
a save that would grant a permission the user saving it does not hold.

The raw settings editor no longer lets a user without `server-settings:write-sensitive` replace a server's connection
details while that server's stored settings are invalid.
