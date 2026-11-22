---
audience: users
kind: added
---

`/reqlayer` and `/vote` take `--filters` (`-f`) to choose the filters a request or vote uses. The filters named
replace the server's layer request filters for `/reqlayer`, and the pool filter for `/vote`. Separate the filters with
commas, put `!` before one to invert it, or give `none` to use no filters: `/reqlayer narva -f mainpool,!jensens`. The
repeat rules still apply to `/vote`.

A filter can be named by part of its name or by its id, in `--filters` and among the words of `/reqlayer` and `/vote`.
When a name matches no filter or several, SLM lists the filters it could mean. Reply with a number to pick one. Every
mistyped word and filter in a `/reqlayer` or `/vote` is asked about in the same exchange, one question after another,
and the answers can be given together: `1 1`.

Only admins who can edit the queue can choose the filters of a `/reqlayer` request.
