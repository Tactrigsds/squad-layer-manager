---
audience: users
kind: added
---

`/reqlayer` and `/vote` take `--filters` (`-f`) to choose the filters a request or vote uses. The filters named
replace the server's layer request filters for `/reqlayer`, and the pool filter for `/vote`. Separate the names with
commas, put `!` before a name to invert that filter, or give `none` to use no filters: `/reqlayer narva -f
mainpool,!jensens`. The repeat rules still apply to `/vote`.

Only admins who can edit the queue can choose the filters of a `/reqlayer` request.
