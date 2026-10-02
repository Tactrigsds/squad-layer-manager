import type * as Cleanup from '@/lib/cleanup'
import * as ReactRx from '@/lib/react-rxjs'
import * as Rx from '@/lib/rxjs'
import * as V from '@/models/vote.models'
import * as RPC from '@/orpc.client'
import * as PartSys from '@/systems/parts.client'

// casts arrive as deltas against the state before them, so the state is folded on the stream that receives them in
// order, before the binding that shares it
const voteStateCold$ = (serverId: string) =>
	RPC.observe('vote.watchUpdates', () => RPC.orpc.vote.watchUpdates.call({ serverId })).pipe(
		RPC.dropUnavailable(),
		Rx.tap((update) => {
			if (update.code === 'initial-state' && update.state) {
				PartSys.stripParts(update.state)
			} else if (update.code === 'update' && !V.isVoteCastUpdate(update.update)) {
				PartSys.stripParts(update.update)
			}
		}),
		Rx.scan(
			(acc: { update: V.VoteStateUpdateOrInitialWithParts | null; state: V.VoteState | null }, update) => {
				if (update.code === 'initial-state') return { update, state: update.state }
				const next = update.update
				return { update, state: V.isVoteCastUpdate(next) ? V.applyVoteCast(acc.state, next.cast) : next.state }
			},
			{ update: null, state: null },
		),
		Rx.share(),
	)

export const [useVoteStateUpdate, voteStateUpdate$] = ReactRx.bindWithDefault((serverId: string) => voteStateCold$(serverId), {
	update: null,
	state: null,
})
export const [useVoteState, voteState$] = ReactRx.bindWithDefault(
	(serverId: string) => voteStateUpdate$(serverId).pipe(Rx.map(({ state }) => state)),
	null,
)

export function watchServer(serverId: string, cleanup: Cleanup.Tasks) {
	cleanup.push(voteStateUpdate$(serverId).subscribe())
	cleanup.push(voteState$(serverId).subscribe())
}
