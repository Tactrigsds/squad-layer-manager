# In-game voting

Squad has a voting system of its own, turned on with `AdminEnableVoting 1` over RCON or from the in-game admin
panel. It is unrelated to SLM's vote system: players vote in-game at the end of a match, and the result is written
straight to the server's next layer.

That last part is the problem. SLM sets the next layer from the queue, the vote resolves afterwards, and the vote
wins. Everything SLM writes from the moment a vote opens until the map rolls is discarded, so the queue and the
server disagree about what is coming next and nobody is told why.

## What SLM does about it

The log lines a vote emits are parsed into an `INGAME_VOTE_STARTED` server event (see `RconEvents` in
`src/models/squad.models.ts`). The anchor is the container-creation line, with the choices line from the same tick
folded in through `INGAME_VOTE_CHAIN`:

```
LogSquad: Vote Possible choices: Fallujah_Skirmish_v2 Mutaha_Skirmish_v1 ... RegenerateVote
LogSquad: Vote: Create new container: Vote_NextLayer
LogSquad: Vote: Update vote for used container: Vote_NextLayer
```

One vote runs through several containers in turn: `Vote_NextLayer` for the map and gamemode, then `Vote_Faction_<n>`
for each team's faction. They are stages of the same vote, not different kinds of vote, and nothing branches on the
name. `RegenerateVote` is the server's re-roll option rather than something that can be played, so it is dropped
from the choices.

Whether a vote is under way at all is the only question anything asks. If one is, it is what decides the next
layer: SLM stops writing the rotation and records the match the roll produces with a layer source of `ingame-vote`
rather than attributing it to (and consuming) the queue head, which it never got to set.

`updatesToSquadServerDisabled` holds the reason rather than a bare flag -- `null` when SLM is writing the rotation,
otherwise `{ type: 'manual', by }` or `{ type: 'ingame-vote' }` -- so a server that is not being written to always
says why, and the queue panel shows it. SLM only claims the reason for itself when updates were on: a vote starting
while an admin already has updates off leaves their reason, and theirs, in place.

Enabling voting clears the server's next layer, and nothing is logged when an admin enables it. That cleared next
layer is the only signal SLM gets, so a server that has a queue head to write, is not mid-roll, and still reports no
next layer after a grace period is read as having had voting turned on. The reason is stored with `inferred: true`
and shown as a likelihood rather than a fact, since SLM deduced it instead of seeing it. The grace period matters:
a roll clears the next layer too, and SLM's own write lands just after, so a shorter wait would read every roll as
a vote.

"Enable In-Game Voting" in the server actions does both halves at once -- `AdminEnableVoting 1` and standing SLM
down -- because doing either alone leaves the two overwriting each other.

Re-enabling SLM's updates also runs `AdminEnableVoting 0`. Turning the vote off is the only way to stop it
deciding the next layer, so without that SLM would go straight back to setting a layer the vote overwrites. The
queue-panel button, the `enableslm` reply and the `slmstatus` reply all say so.

Updates stay off after the map rolls, deliberately. Whoever turned voting on has taken over the rotation, and
having SLM quietly start fighting the vote again on the next match is worse than leaving the setting where an admin
put it. The runtime vote state (`ctx.layerQueue.ingameVote$`) does clear at the match boundary, since a vote never
outlives its match, but the reason is persisted and does not: the alert goes on naming the vote as why updates are
off until someone re-enables them.

## Where it shows up

- The queue panel alert (`SlmUpdatesDisabledAlert`), which names the vote and its choices and explains that the
  vote, not an admin, is why updates are off.
- The event feed, as an `INGAME_VOTE_STARTED` entry.
- Admins in-game, via an RCON warn.
- The audit log, as a settings update with source `ingame-vote-detected`, which is what distinguishes SLM
  disabling itself from an admin doing it by hand.

## Caveats

Squad does not log a vote _ending_ in any form we have a sample of, so SLM cannot see a vote finish. The runtime
state is cleared at the next `NEW_GAME` instead. In practice a vote is only open in the run-up to a roll, so this
is the right boundary, but it does mean a vote that is cancelled without a roll stays "running" in the UI until the
next match starts.

## Testing it

The emulator can open a vote:

```sh
pnpm emuctl vote                                  # a layer vote with default choices
pnpm emuctl vote layer Mutaha_Skirmish_v1 Chora_Skirmish_v1
pnpm emuctl vote faction BAF MEI VDV
```
