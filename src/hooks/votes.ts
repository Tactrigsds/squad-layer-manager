import { trpc } from '@/lib/trpc.client'
import * as M from '@/models.ts'
import { useMutation } from '@tanstack/react-query'
import * as PartSys from '@/systems.client/parts'

import { Observable, share, map } from 'rxjs'
import { bind } from '@react-rxjs/core'

const voteStateCold$ = new Observable<M.VoteStateUpdateOrInitial>((s) => {
	const sub = trpc.layerQueue.watchVoteStateUpdates.subscribe(undefined, {
		onData: (update) => {
			if (update.code === 'initial-state' && update.state) {
				PartSys.stripParts(update.state)
			} else if (update.code === 'update') {
				PartSys.stripParts(update.update)
			}
			return s.next(update)
		},
		onComplete: () => s.complete(),
		onError: (e) => s.error(e),
	})
	return () => sub.unsubscribe()
}).pipe(share())

export const [useVoteStateUpdate, voteStateUpdate$] = bind(voteStateCold$ as Observable<M.VoteStateUpdateOrInitialWithParts | null>, null)
export const [useVoteState, voteState$] = bind(
	voteStateUpdate$.pipe(
		map((stateOrUpdate): null | M.VoteState => {
			if (!stateOrUpdate) return null
			return stateOrUpdate.code === 'initial-state' ? stateOrUpdate.state : stateOrUpdate.update.state
		})
	),
	null
)

export function useStartVote() {
	return useMutation({
		mutationFn: trpc.layerQueue.startVote.mutate,
	})
}

export function useAbortVote() {
	return useMutation({
		mutationFn: trpc.layerQueue.abortVote.mutate,
	})
}
