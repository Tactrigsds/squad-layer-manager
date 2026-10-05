---
audience: operators
kind: fixed
---

An admin list whose source cannot be read no longer takes admin status away from everyone on it. SLM keeps the list from its last successful read and logs a warning each time a read fails.

A remote source that answers with an HTTP error now counts as a failed read, not as an empty list. A list that has not been read successfully since SLM started still grants nothing.
