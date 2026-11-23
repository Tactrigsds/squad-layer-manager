---
audience: users
kind: added
---

Admins can generate a vote from game chat with `/vote`, and run a vote between text choices with `/simplevote`.

`/vote narva skorpo goro` generates a vote with one layer from the pool for each map named, and puts the vote first in
the queue. The choices can also all be layers, gamemodes or sizes, and a filter name applies to every choice. When the
pool has no layer for a choice, SLM names that choice and queues nothing.

A vote's choices can show players a text of their own in place of the layer's name. Type it after a colon in `/vote`,
with underscores for spaces: `/vote narva:Night_ops skorpo`. The vote's display options set the same texts from the
dashboard.

`/simplevote yes, no, not sure` starts a vote that leaves the queue as it is. Commas separate the choices. Without a
comma, each word is a choice. `--internal` (`-i`) has only the admins vote, in admin chat, and `--duration 2m` (`-d`)
sets how long the vote runs. `/startvote` takes the same two options for the vote at the head of the queue. A simple
vote can also be started from the activity panel's chat box, which sets the same two options.

Every vote, layer or simple, shows its tally and countdown in a box at the top of the activity feed, with the
controls to end or abort it. A layer vote's result stays in the box until the next match starts, and a simple
vote's result stays for 15 minutes. The queue no longer shows a running vote's tally.
