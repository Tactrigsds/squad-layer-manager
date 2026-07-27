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

The container name gives the kind: `Vote_NextLayer` is a `next-layer` vote, `Vote_Faction_<n>` a `faction` vote.
`RegenerateVote` is the server's re-roll option rather than something that can be played, so it is dropped from the
choices.

On a `next-layer` vote SLM sets `updatesToSquadServerDisabled` and stops writing the rotation. Faction votes leave
the layer alone, so they are recorded and shown but change nothing.

Updates stay off after the map rolls, deliberately. Whoever turned voting on has taken over the rotation, and
having SLM quietly start fighting the vote again on the next match is worse than leaving the flag where an admin
put it. The runtime vote state (`ctx.layerQueue.ingameVote$`) does clear at the match boundary, since a vote never
outlives its match; the alert then goes back to the plain "SLM Updates Disabled" wording until someone re-enables
them.

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
