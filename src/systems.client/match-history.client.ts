import { distinctDeepEquals } from '@/lib/async'
import * as MH from '@/models/match-history.models'
import * as PartsSys from '@/systems.client/parts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import * as Rx from 'rxjs'

export const [useMatchHistoryState, matchHistoryState$] = ReactRx.bind(
	new Rx.Observable<MH.PublicMatchHistoryState>(s => {
		const sub = trpc.matchHistory.watchMatchHistoryState.subscribe(undefined, {
			onData: output => {
				PartsSys.upsertParts(output.parts)
				s.next(output)
			},
			onComplete: () => {
				console.trace('match history completed')

				s.complete()
			},
			onError: err => s.error(err),
		})
		return () => sub.unsubscribe()
	}),
	{ activeTriggerEvents: [], recentBalanceTriggerEvents: [], recentMatches: [] },
)

export const [useRecentMatches, recentMatches$] = ReactRx.bind(
	matchHistoryState$.pipe(Rx.map((state) => state.recentMatches)),
	[],
)

export const [useRecentMatchHistory, recentMatchHistory$] = ReactRx.bind(
	() =>
		currentMatchDetails$().pipe(
			Rx.withLatestFrom(recentMatches$),
			Rx.map(([currentMatch, matchHistory]) => {
				if (currentMatch === null) return [...matchHistory]
				return matchHistory.slice(0, matchHistory.length - 1)
			}),
			distinctDeepEquals(),
		),
	[],
)

export const [useCurrentMatchDetails, currentMatchDetails$] = ReactRx.bind(
	() =>
		Rx.combineLatest([recentMatches$, SquadServerClient.squadServerStatus$])
			.pipe(
				Rx.map(([recentMatches, serverStatus]) => {
					if (serverStatus.code === 'err:rcon') return null
					if (!serverStatus.data.currentMatchId) return null
					const currentMatch = recentMatches[recentMatches.length - 1]
					if (currentMatch?.historyEntryId === serverStatus.data.currentMatchId) return currentMatch
					return null
				}),
				distinctDeepEquals(),
			),
	null,
)

export function setup() {
	recentMatchHistory$().subscribe()
	currentMatchDetails$().subscribe()
}
