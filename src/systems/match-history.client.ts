import * as RxHelpers from '@/lib/react-rxjs-helpers'
import type * as MH from '@/models/match-history.models'
import * as RPC from '@/orpc.client'
import * as PartsSys from '@/systems/parts.client'

import * as ReactRx from '@react-rxjs/core'
import { createSignal } from '@react-rxjs/utils'
import * as Rx from 'rxjs'

const [initialized$, setInitialized] = createSignal<boolean>()

export const [useMatchHistoryState, matchHistoryState$] = ReactRx.bind(
	(serverId: string) =>
		RPC.observe('matchHistory.watchMatchHistoryState', () => RPC.orpc.matchHistory.watchMatchHistoryState.call({ serverId })).pipe(
			RPC.dropServerNotLoaded(),
			Rx.map(PartsSys.stripParts),
		),
	{ recentBalanceTriggerEvents: [], recentMatches: [] } satisfies MH.PublicMatchHistoryState,
)

export const [useRecentMatches, recentMatches$] = RxHelpers.bind(
	'matchHistory.recentMatches',
	(serverId: string) =>
		matchHistoryState$(serverId).pipe(Rx.map((state) => {
			return [...state.recentMatches]
		})),
)

export const [useCurrentMatch, currentMatch$] = RxHelpers.bind(
	'matchHistory.currentMatch',
	(serverId: string) => recentMatches$(serverId).pipe(Rx.map(matches => (matches[matches.length - 1]) as MH.MatchDetails | undefined)),
)

export const [useInitializedRecentMatches, initializedRecentMatches$] = RxHelpers.bind(
	'matchHistory.initializedRecentMatches',
	(serverId: string) =>
		initialized$.pipe(
			Rx.map(() => recentMatches$(serverId).getValue()),
		),
)

export async function resolveInitializedRecentMatches(serverId: string) {
	const recentMatches = await Rx.firstValueFrom(initializedRecentMatches$(serverId).pipe(Rx.filter(v => !!v)))
	return recentMatches
}

export function watchServer(serverId: string, sub: Rx.Subscription) {
	sub.add(
		matchHistoryState$(serverId).subscribe(() => {
			setInitialized(true)
		}),
	)
	sub.add(initializedRecentMatches$(serverId).pipe(RxHelpers.retryHot()).subscribe())
	sub.add(currentMatch$(serverId).pipe(RxHelpers.retryHot()).subscribe())
}
