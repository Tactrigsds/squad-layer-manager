# Command triggers

An in-game command runs from one of its _triggers_: the strings listed against it under
_Settings > In-game Commands_. `/timeout` and `/to` are two triggers for the same command, and typing either takes
the command's arguments exactly as written.

A trigger can also pin some of those arguments. Give it an `args` template and it becomes a shortcut, which is what
command aliases used to be.

See [configuring.md](configuring.md#5-in-game-commands) for the commands themselves, and for the prefix every
trigger starts with.

## Shortcuts

| Trigger   | Pinned args                                  | Typed in chat           | Runs                         |
| --------- | -------------------------------------------- | ----------------------- | ---------------------------- |
| `/to`     | (none)                                       | `/to Alice 2h spamming` | `/timeout Alice 2h spamming` |
| `/to2h`   | `{{arg1}} 2h {{rest2}}`                      | `/to2h Alice spamming`  | `/timeout Alice 2h spamming` |
| `/rules`  | `Read the rules`                             | `/rules`                | `/broadcast Read the rules`  |
| `/say`    | `{{rest}}`                                   | `/say back in 5`        | `/broadcast back in 5`       |
| `/warnsp` | `{{arg1}} {{^rest2}}spam{{/rest2}}{{rest2}}` | `/warnsp Alice`         | `/warn Alice spam`           |

## How the numbers work

**The numbers count the words the caller types, not the words of the command that ends up running.** `{{arg1}}` is
the first word typed after the trigger, `{{arg2}}` the second, and so on. `{{restN}}` is the Nth word typed onwards,
joined by spaces, and `{{rest}}` is all of them. Use `{{restN}}` for anything that can be more than one word, such
as a reason.

Pinned text sits outside that counting, which is what makes `{{arg1}} 2h {{rest2}}` read correctly. The caller never
types the duration, so nothing indexes it.

```
they type:   Alice      spamming badly
             {{arg1}}   {{rest2}}          <- the numbers count these words
it runs:     Alice  2h  spamming badly
                    ^^ pinned text, never typed, so no placeholder refers to it
```

Once a trigger has pinned arguments, the command's card in _Settings > In-game Commands_ shows which placeholder
fills which argument (`{{arg1}} <player>  {{arg2}} <duration>  {{rest3}} <reason|message>`), including whether each
one is required under the current reason settings.

## Words the caller leaves out

A word that is left out renders as nothing and its token drops out, which is what makes it optional: `/to2h Alice`
runs `/timeout Alice 2h` with no reason. `{{^arg2}}fallback{{/arg2}}` puts something in its place instead. Words the
template never mentions are ignored.

A pinned-argument template is not the same as writing `{{rest}}`. A placeholder stands for one word when the
arguments are worked out, so `{{rest}}` alone means "the player, and nothing else" rather than "everything as
typed". Leave the args off entirely for a plain trigger.

## What a trigger cannot do

Every trigger string across every command shares one namespace, and two commands cannot claim the same one. A
trigger runs in its command's allowed chats, so pinning arguments cannot turn a public trigger into an admin
command. What it can do is let a public trigger pass a player's own words into a public command's free-text
argument, which is worth keeping in mind when writing one.

## Finding them

The commands page lists a command's shortcut triggers under its details, and searching for one finds the command it
runs. `/help` lists each shortcut on its own line, since each one asks the caller for something different.

## When every trigger pins something

Leave a command no plain trigger and the shortcuts are all there is, so they are listed as the command itself
rather than under it. The examples follow the first of them, and an argument they all pin is shown by the value it
is fixed at instead of as a word to type:

```
/timeout <player>
/to <player>
  <player>   name | id
  duration   fixed at 45m
```

An argument nothing passes on is left out entirely. `{{arg1}} 45m` never reaches `<reason>`, so a timeout run this
way cannot carry one, and the page says so by not offering it.
