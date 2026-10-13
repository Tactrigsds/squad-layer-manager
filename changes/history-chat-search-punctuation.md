---
audience: users
kind: fixed
---

The history page's _Chat contains_ filter no longer fails with a server error when the text includes punctuation such
as `!`, `-` or `"`.

The filter matches its words as typed, next to each other and in order. `NOT`, `AND` and `OR` are searched for as
ordinary words. A player name search of two characters that includes an emoji now finds the matching players.
