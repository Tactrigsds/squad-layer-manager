---
audience: users
kind: added
---

RCON commands can be run from the server console. Type a command into the box at the bottom of the RCON tab and press Enter.
Press Up and Down in the box to step through earlier commands, as in a terminal.

Running commands requires the new `squad-server:write-console` permission, which no role holds until an admin grants
it. `squad-server:view-console` still grants reading the console only. Every command run from the console is recorded
in the audit log and in the server's activity feed.

The console no longer has an **All** tab. The RCON tab shows only commands run from the console until **Show SLM
requests** or **Show events** is ticked.
