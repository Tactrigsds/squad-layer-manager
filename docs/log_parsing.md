# Log parsing: ticks, chains and the tick partition

`SM.LogEvents.parseLogStream` turns a SquadGame.log byte stream into events. Most of it is
line-by-line matching, but one part carries design weight and is easy to get wrong: how a group of
log lines becomes a single chain event.

## chainID is an engine tick, not a chain

Every log line carries a `[timestamp][chainID]` header. The `chainID` is Unreal's frame counter, so
all lines emitted during one server frame share it. It is a batching artifact of the log format. It
is not a statement that those lines are related.

The parser buffers lines by `chainID` and flushes the buffer when the chainID changes. That much is
sound: measured across ~415MB of production logs (627k ticks, 84k recognized events), **no chain
ever spans a tick boundary**, so a tick is a safe unit to assemble chains within. What is not sound
is assuming a tick contains _only_ one chain and nothing else.

A single tick routinely holds:

- a chain plus unrelated events, because a frame does many things at once
- two instances of the same chain, when two players join on one frame
- a chain member that appears _before_ its own primary (`LAYER_CHANGED` precedes `ROUND_ENDED`)

## What the tick partition does

`partitionTick` walks the buffered tick three times:

1. every event whose type is a chain `primary` opens a chain instance, recording its buffer index
2. every other chain-member event is absorbed by the most recent instance already open at that
   point which is still missing that member; failing that, by the first instance of its chain that
   is still missing it (this is the case that handles a member preceding its primary)
3. the tick is emitted in log order: an instance is emitted at the position of its primary, and
   every event not absorbed by an instance is emitted standalone

The ordering rule in step 2 is a heuristic, and deliberately so. Chain instances in one tick are
sequential in every log we have (instance A completes before instance B opens), so correlating
members to instances by identity -- player EOS id, squad id -- buys nothing over position. If
concurrent interleaved chains ever show up, that is the point to revisit it, and
`src/scripts/scan-chain-straddles.ts` is the tool that will show it.

## The invariant

> A recognized log entry is either emitted, folded into exactly one emitted chain event, or reported
> in `errors`. It is never silently discarded.

Only a chain failing `validateChainEvent` may withhold events, and only its own members. Anything
that belongs to no chain -- `NEW_GAME` above all -- must always come out.

This is asserted in `squad.models.test.ts` (`LogEvents.parse conservation`) against
`test/fixtures/log-chain-ticks.json`, which holds real tick groups pulled from the archive and
weighted towards ticks where a chain shares its chainID with something else.

## Why this matters

The invariant is not academic. Before the partition existed, the flush found the first primary in
the tick, rebuilt one chain from the member types it recognized, and dropped the remainder of the
buffer. On 2026-07-21 a map roll put the destination layer's `NEW_GAME` in the same frame as the
first player's join, twice in one day. Both times the `NEW_GAME` was discarded, the pending-event
state machine stayed in `rolling` against the previous match, and it took the 90s sync watchdog to
notice -- which then resynced against the stale layer. In one of the two the server went on to warn
every player that the layer it was already running was "next".

Across the archive the same defect was discarding ~3,000 recognized events, most of them harmless
`PLAYER_RESTARTED`, but also kicked players' `PLAYER_DISCONNECTED`, wounds, deaths, and one join out
of every pair that landed on the same frame.
