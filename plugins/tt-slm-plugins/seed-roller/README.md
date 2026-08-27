# seed-roller

When the server is sitting on a training layer and enough people have turned up, this queues a seeding layer,
tells the admins, and ends the match.

## What it does

While the current layer is a training layer, it checks every five seconds whether the criteria are met. When
they are, it:

1. Puts a seeding layer at the head of the queue and something real behind it, and drops every other training
   layer. A seeding layer an admin already queued is left alone.
2. Warns every in-game admin and posts to Discord.
3. Counts down, during which any admin can cancel from the server dashboard.
4. Broadcasts to the server and ends the match.

It arms at most once per match. A cancel, a failure or a completed roll all stand until the next one.

## Settings

**Criteria** is a javascript expression. The variables are `population`, `afkPopulation`,
`activePopulation`, and `currentTime`, which is `{ hour, minute, minutesOfDay, weekday }` with `0` for Sunday
and `minutesOfDay` counted from local midnight. The default is 18 or more players between 2:00 and 3:30 pm:

```js
population >= 18 && currentTime.minutesOfDay >= 14 * 60 && currentTime.minutesOfDay <= 15 * 60 + 30
```

**Timezone** is the zone that clock is read in. Name a zone rather than an offset, so the window does not
move when daylight saving changes.

**AFK window** is how long since a player last did anything before they stop counting as active. Chat,
kills, squad changes, kit changes and joining all count; SLM's own polling and things done _to_ a player by
an admin do not.

**Editor discord id** is who the queue edits are recorded against. Name the admin answerable for them.

The two pools are filters, and the messages are `{{variable}}` templates. Repeat rules are not applied to
either draw: a seeding layer is played because the server is empty, not because it is due.

## When it does not roll

The panel on the server dashboard says which of these it hit:

- an admin has unsaved queue edits open, in which case it leaves the queue alone rather than discarding them
- either pool matched no layers
- the game server never reported the seeding layer as next, so ending the match would have rolled onto the
  wrong one
