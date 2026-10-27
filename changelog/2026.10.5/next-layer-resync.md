---
audience: users
kind: fixed
---

The next layer no longer drifts off the queue after an admin changes it from outside SLM.

With _Override the next layer when it is set outside SLM_ on, SLM sometimes let an outside change stand. After a match that was not the first item in the queue, SLM also left the server's own rotation to pick the following layer. SLM now sets the first item in the queue as the next layer in both cases.
