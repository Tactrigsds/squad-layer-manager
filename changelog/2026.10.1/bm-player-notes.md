---
audience: users
kind: added
---

Admins can add notes to a player's BattleMetrics profile and read the notes already there.

- In the player details window, click the notebook button next to the flag editor to add a note. Click **Load notes**
  to list the player's notes, newest first, with who wrote each one.
- Right-click a player, a squad or a selection and pick **Add Note...** to add the same note to each of them.
- In admin chat, type `!note <player> <text>` to add a note.

SLM posts each note to BattleMetrics signed with the name of the admin who wrote it. SLM fetches a player's notes only
when **Load notes** is clicked, because each fetch counts against your organization's BattleMetrics request limit.
