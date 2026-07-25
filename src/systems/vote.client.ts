import * as ReactRx from '@/lib/react-rxjs'
import * as Rx from '@/lib/rxjs'
import type * as V from '@/models/vote.models'
import * as RPC from '@/orpc.client'
import * as PartSys from '@/systems/parts.client'

const voteStateCold$ = (serverId: string) =>
	RPC.observe('vote.watchUpdates', () => RPC.orpc.vote.watchUpdates.call({ serverId })).pipe(
		RPC.dropServerNotLoaded(),
		Rx.tap((update) => {
			if (update.code === 'initial-state' && update.state) {
				PartSys.stripParts(update.state)
			} else if (update.code === 'update') {
				PartSys.stripParts(update.update)
			}
		}),
		Rx.share(),
	)

export const [useVoteStateUpdate, voteStateUpdate$] = ReactRx.bindWithDefault((serverId: string) => voteStateCold$(serverId), null)
export const [useVoteState, voteState$] = ReactRx.bindWithDefault(
	(serverId: string) =>
		voteStateUpdate$(serverId).pipe(
			Rx.map((stateOrUpdate): null | V.VoteState => {
				if (!stateOrUpdate) return null
				return stateOrUpdate.code === 'initial-state' ? stateOrUpdate.state : stateOrUpdate.update.state
			}),
		),
	null,
)

export function watchServer(serverId: string, sub: Rx.Subscription) {
	sub.add(voteStateUpdate$(serverId).subscribe())
	sub.add(voteState$(serverId).subscribe())
}
