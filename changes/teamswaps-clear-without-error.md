---
audience: users
kind: fixed
---

Saved teamswaps no longer fail with a "NOT NULL constraint failed" error when they run at the start of a new match, are swapped now, or are cleared.

At the start of a new match, the players were still swapped, but the toast reported the swap as failed.
