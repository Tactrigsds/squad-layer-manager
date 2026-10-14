---
audience: operators
kind: added
---

Plugins can run jobs on a schedule, or once at a time they pick. SLM keeps scheduled runs across restarts, catches up
a run that came due while it was down, and retries a run that fails. A run that cannot go ahead yet waits instead of
failing, such as one that adds layers while an admin has unsaved queue edits, or one whose server is not loaded.

The settings page lists each running plugin's jobs, with when each next runs, what a waiting run is waiting for, and
how its last run went, and the runs it has scheduled. Use _Run now_ to run a job straight away, _Cancel_ to remove a
scheduled run, and _Stop_ to stop a running one. All three need the permission to manage plugins.

The audit log records a job run that fails, including one still waiting when its time runs out or one that ran too
long, a run an admin started by hand or stopped, and every run of a job that asks for its successes to be recorded. A job that runs for a server also appears
in that server's activity feed.

The plugin API adds `slm/plugin/schedule`.
