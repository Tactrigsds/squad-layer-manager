import { fromOrpcSubscription } from '@/lib/async'
import * as V from '@/models/vote.models'
import * as PartSys from '@/systems.client/parts'
import { orpc } from '@/trpc.client'
import { bind } from '@react-rxjs/core'
import * as Rx from 'rxjs'
import { map, share } from 'rxjs'

const voteStateCold$ = fromOrpcSubscription(() => orpc.layerQueue.watchVoteStateUpdates()).pipe(
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

export const startVoteOpts = {
	mutationFn: orpc.layerQueue.startVote,
}

export const abortVoteOpts = {
	mutationFn: orpc.layerQueue.abortVote,
}

export const cancelVoteAutostartOpts = {
	mutationFn: orpc.layerQueue.cancelVoteAutostart,
}
