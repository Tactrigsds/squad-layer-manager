import type * as MH from '@/models/match-history.models'
import * as RPC from '@/orpc.client'
import * as PartsSys from '@/systems/parts.client'

import * as ReactRx from '@react-rxjs/core'
import { createSignal } from '@react-rxjs/utils'
import * as Rx from 'rxjs'

const [initialized$, setInitialized] = createSignal<boolean>()

export const [useMatchHistoryState, matchHistoryState$] = ReactRx.bind(
	(serverId: string) =>
		RPC.observe(() => RPC.orpc.matchHistory.watchMatchHistoryState.call({ serverId })).pipe(Rx.map(PartsSys.stripParts)),
	{ recentBalanceTriggerEvents: [], recentMatches: [] } satisfies MH.PublicMatchHistoryState,
)

export const [useRecentMatches, recentMatches$] = ReactRx.bind(
	(serverId: string) =>
		matchHistoryState$(serverId).pipe(Rx.map((state) => {
			return [...state.recentMatches]
		})),
)

export const [useCurrentMatch, currentMatch$] = ReactRx.bind(
	(serverId: string) => recentMatches$(serverId).pipe(Rx.map(matches => (matches[matches.length - 1]) as MH.MatchDetails | undefined)),
)

export const [useInitializedRecentMatches, initializedRecentMatches$] = ReactRx.bind(
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
	sub.add(initializedRecentMatches$(serverId).subscribe())
	sub.add(currentMatch$(serverId).subscribe())
}
