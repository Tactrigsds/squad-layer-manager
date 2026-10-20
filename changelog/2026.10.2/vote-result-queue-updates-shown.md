---
audience: users
kind: fixed
---

The audit log shows the queue update that records a vote's result.

When a choice other than the first won a vote, the queue update that applied the result was missing from the audit
log. The update also dropped out of the activity feed once SLM restarted or the match ended. The upgrade restores the updates
that are already recorded.
