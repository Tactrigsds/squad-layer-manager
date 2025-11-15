import type * as V from '@/models/vote.models'
import * as RPC from '@/orpc.client'
import * as PartSys from '@/systems.client/parts'
import { bind } from '@react-rxjs/core'
import * as Rx from 'rxjs'
import { map, share } from 'rxjs'

const voteStateCold$ = RPC.observe(() => RPC.orpc.layerQueue.watchVoteStateUpdates.call()).pipe(
	Rx.tap((update) => {
		if (update.code === 'initial-state' && update.state) {
			PartSys.stripParts(update.state)
		} else if (update.code === 'update') {
			PartSys.stripParts(update.update)
		}
	}),
	share(),
)

export const [useVoteStateUpdate, voteStateUpdate$] = bind(voteStateCold$, null)
export const [useVoteState, voteState$] = bind(
	voteStateUpdate$.pipe(
		map((stateOrUpdate): null | V.VoteState => {
			if (!stateOrUpdate) return null
			return stateOrUpdate.code === 'initial-state' ? stateOrUpdate.state : stateOrUpdate.update.state
		}),
	),
	null,
)

export function setup() {
	voteStateUpdate$.subscribe()
	voteState$.subscribe()
}
