import type * as V from '@/models/vote.models'
import * as RPC from '@/orpc.client'
import * as PartSys from '@/systems/parts.client'
import { bind } from '@react-rxjs/core'
import * as Rx from 'rxjs'
import { map, share } from 'rxjs'

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
		share(),
	)

export const [useVoteStateUpdate, voteStateUpdate$] = bind((serverId: string) => voteStateCold$(serverId), null)
export const [useVoteState, voteState$] = bind(
	(serverId: string) =>
		voteStateUpdate$(serverId).pipe(
			map((stateOrUpdate): null | V.VoteState => {
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
