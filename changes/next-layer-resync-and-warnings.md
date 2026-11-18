---
audience: users
kind: fixed
---

SLM puts the server's next layer back in line with the queue when the server changes it without logging the change, and warns in-game admins when the next layer leaves the queue.

With _Override the next layer when it is set outside SLM_ on, SLM sets the queue's next layer back and warns every admin, naming the admin who changed it when the server log does. With the setting off, SLM adopts the server's layer into the queue. Admins are also warned when a match starts on a layer the server picked itself. A next layer the server refuses is retried.
