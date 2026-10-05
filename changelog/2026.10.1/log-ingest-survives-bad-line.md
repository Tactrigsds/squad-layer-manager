---
audience: operators
kind: fixed
---

A log line that SLM cannot parse no longer stops SLM reading the server's log. Before, events stopped appearing until SLM was restarted.

Busy moments no longer stall SLM. A burst of a thousand kills or chat messages, a warn to every player, or a map change held up the rest of SLM for up to a second. Each now holds SLM up for a few tens of milliseconds at most.
