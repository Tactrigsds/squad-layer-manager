import * as TrpcHelpers from '@/lib/trpc-helpers'
import * as MH from '@/models/match-history.models'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import { createSignal } from '@react-rxjs/utils'
import * as Rx from 'rxjs'

const [initialized$, setInitialized] = createSignal<boolean>()

export const [useMatchHistoryState, matchHistoryState$] = ReactRx.bind<MH.PublicMatchHistoryState>(
	TrpcHelpers.fromTrpcSub(undefined, trpc.matchHistory.watchMatchHistoryState.subscribe),
	{ recentBalanceTriggerEvents: [], recentMatches: [] },
)

export const [useRecentMatches, recentMatches$] = ReactRx.bind(
	matchHistoryState$.pipe(Rx.map((state) => {
		return state.recentMatches
	})),
)

export const [useInitializedRecentMatches, initializedRecentMatches$] = ReactRx.bind(
	() =>
		initialized$.pipe(
			Rx.map(() => recentMatches$.getValue()),
		),
)

export async function resolveInitializedRecentMatches() {
	const recentMatches = await Rx.firstValueFrom(initializedRecentMatches$().pipe(Rx.filter(v => !!v)))
	return recentMatches
}

export const [useRecentMatchHistory, recentMatchHistory$] = ReactRx.bind(
	() =>
		Rx.combineLatest([recentMatches$, SquadServerClient.currentMatch$])
			.pipe(
				Rx.map(([matchHistory, currentMatch]) => {
					if (currentMatch === null) return [...matchHistory]
					return matchHistory.slice(0, matchHistory.length - 1)
				}),
			),
	[],
)

export function setup() {
	matchHistoryState$.subscribe(() => {
		setInitialized(true)
	})
	recentMatchHistory$().subscribe()
	initializedRecentMatches$().subscribe()
}
