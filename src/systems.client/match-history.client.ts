import { distinctDeepEquals } from '@/lib/async'
import * as SM from '@/lib/rcon/squad-models'
import * as PartsSys from '@/systems.client/parts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import * as Rx from 'rxjs'

export const [useMatchHistory, matchHistory$] = ReactRx.bind(
	new Rx.Observable<SM.MatchDetails[]>(s => {
		const sub = trpc.matchHistory.watchRecentMatchHistory.subscribe(undefined, {
			onData: output => {
				PartsSys.upsertParts(output.parts)
				s.next(output.recentMatches)
			},
			onComplete: () => {
				console.trace('match history completed')

				s.complete()
			},
			onError: err => s.error(err),
		})
		return () => sub.unsubscribe()
	}),
	[],
)

export const [useRecentMatchHistory, recentMatchHistory$] = ReactRx.bind(
	() =>
		currentMatchDetails$().pipe(
			Rx.withLatestFrom(matchHistory$),
			Rx.map(([currentMatch, matchHistory]) => {
				if (currentMatch === null) return matchHistory
				return matchHistory.slice(1)
			}),
			distinctDeepEquals(),
		),
	[],
)

export const [useCurrentMatchDetails, currentMatchDetails$] = ReactRx.bind(
	() =>
		Rx.combineLatest([matchHistory$, SquadServerClient.squadServerStatus$])
			.pipe(
				Rx.map(([matchHistory, serverStatus]) => {
					if (serverStatus.code === 'err:rcon') return null
					if (!serverStatus.data.currentMatchId) return null
					const currentMatch = matchHistory[0]
					if (currentMatch?.historyEntryId === serverStatus.data.currentMatchId) return currentMatch
					return null
				}),
				distinctDeepEquals(),
			),
	null,
)
