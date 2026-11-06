---
audience: users
kind: added
---

The new Scheduled Commands plugin runs RCON commands on your servers on a schedule. A task can run on an interval, at set times from a cron pattern, a set time after each match starts, or a set time after each match ends.

Each task is listed under the plugin on the settings page with its next run and its last result. Click _Run now_ to run a task straight away. Commands can include variables such as `{{layer}}`, `{{nextLayer}}`, `{{server}}` and `{{players}}`, filled in each time the task runs. Each command appears in the server's activity feed.
