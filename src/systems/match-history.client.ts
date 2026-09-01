import type * as Cleanup from '@/lib/cleanup'
import * as ReactRx from '@/lib/react-rxjs'
import * as Rx from '@/lib/rxjs'
import * as CHAT from '@/models/chat.models'
import type * as MH from '@/models/match-history.models'
import * as RPC from '@/orpc.client'
import * as PartsSys from '@/systems/parts.client'

const [initialized$, setInitialized] = ReactRx.createSignal<boolean>()

export const [useMatchHistoryState, matchHistoryState$] = ReactRx.bindWithDefault(
	(serverId: string) =>
		RPC.observe('matchHistory.watchMatchHistoryState', () => RPC.orpc.matchHistory.watchMatchHistoryState.call({ serverId })).pipe(
			RPC.dropServerNotLoaded(),
			Rx.map(PartsSys.stripParts),
		),
	{ recentMatches: [] } satisfies MH.PublicMatchHistoryState,
)

export const [useRecentMatches, recentMatches$] = ReactRx.bind('matchHistory.recentMatches', (serverId: string) =>
	matchHistoryState$(serverId).pipe(
		Rx.map((state) => {
			return [...state.recentMatches]
		}),
	),
)

export const [useCurrentMatch, currentMatch$] = ReactRx.bind('matchHistory.currentMatch', (serverId: string) =>
	recentMatches$(serverId).pipe(Rx.map((matches) => matches[matches.length - 1] as MH.MatchDetails | undefined)),
)

export const [useInitializedRecentMatches, initializedRecentMatches$] = ReactRx.bind(
	'matchHistory.initializedRecentMatches',
	(serverId: string) => initialized$.pipe(Rx.map(() => recentMatches$(serverId).getValue())),
)

export async function resolveInitializedRecentMatches(serverId: string) {
	const recentMatches = await Rx.firstValueFrom(initializedRecentMatches$(serverId).pipe(Rx.filter((v) => !!v)))
	return recentMatches
}

export function watchServer(serverId: string, cleanup: Cleanup.Tasks) {
	cleanup.push(
		matchHistoryState$(serverId).subscribe(() => {
			setInitialized(true)
		}),
	)
	cleanup.push(initializedRecentMatches$(serverId).pipe(ReactRx.retryHot()).subscribe())
	cleanup.push(currentMatch$(serverId).pipe(ReactRx.retryHot()).subscribe())
}

/**
 * A finished match's feed, replayed by the server and decoded here.
 *
 * Shared options rather than a hook so the activity panel and the stats panel, which want the same match, agree on
 * the key and fetch it once between them.
 */
export function matchEventsQueryOptions(serverId: string, ordinal: number | null) {
	return {
		queryKey: [...RPC.orpc.matchHistory.getMatchEvents.key(), serverId, ordinal],
		queryFn: async () => {
			if (ordinal === null) return null
			const res = RPC.selectLoaded(await RPC.orpc.matchHistory.getMatchEvents.call({ serverId, ordinal }))
			if (!res) return null
			return { events: CHAT.Wire.decode(res.events) }
		},
		enabled: ordinal !== null,
		staleTime: Infinity,
	}
}
