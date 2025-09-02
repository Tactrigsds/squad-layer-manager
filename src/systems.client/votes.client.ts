import { distinctDeepEquals } from '@/lib/async'
import * as V from '@/models/vote.models'
import * as PartSys from '@/systems.client/parts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { trpc } from '@/trpc.client'
import { bind } from '@react-rxjs/core'
import * as Rx from 'rxjs'
import { map, Observable, share } from 'rxjs'

const voteStateCold$ = new Observable<V.VoteStateUpdateOrInitial>((s) => {
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

export const [useVoteStateUpdate, voteStateUpdate$] = bind(voteStateCold$ as Observable<V.VoteStateUpdateOrInitialWithParts | null>, null)
export const [useVoteState, voteState$] = bind(
	voteStateUpdate$.pipe(
		map((stateOrUpdate): null | V.VoteState => {
			if (!stateOrUpdate) return null
			return stateOrUpdate.code === 'initial-state' ? stateOrUpdate.state : stateOrUpdate.update.state
		}),
	),
	null,
)

export const [useVoteTally, voteTally$] = bind(
	voteState$.pipe(
		Rx.withLatestFrom(SquadServerClient.serverInfoRes$),
		map(([state, squadServerRes]) => {
			if (!state || squadServerRes.code !== 'ok' || !V.isVoteStateWithVoteData(state)) return null
			return V.tallyVotes(state, squadServerRes.data.playerCount)
		}),
		distinctDeepEquals(),
	),
	null,
)

export const startVoteOpts = {
	mutationFn: trpc.layerQueue.startVote.mutate,
}

export const abortVoteOpts = {
	mutationFn: trpc.layerQueue.abortVote.mutate,
}

export const cancelVoteAutostartOpts = {
	mutationFn: trpc.layerQueue.cancelVoteAutostart.mutate,
}
