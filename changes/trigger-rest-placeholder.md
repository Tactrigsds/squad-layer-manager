---
audience: users
kind: changed
---

Trigger templates take the remaining words with `{{rest}}` instead of a numbered `{{rest2}}`, `{{rest3}}` and so on.

`{{rest}}` takes every typed word after the highest-numbered `{{argN}}`. Saved triggers are rewritten to use it on
upgrade. A trigger that used a numbered rest to repeat words an `{{argN}}` already took no longer repeats them.
