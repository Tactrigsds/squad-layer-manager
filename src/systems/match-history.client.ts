import type * as Cleanup from '@/lib/cleanup'
import * as ReactRx from '@/lib/react-rxjs'
import * as Rx from '@/lib/rxjs'
import * as CHAT from '@/models/chat.models'
import type * as MH from '@/models/match-history.models'
import * as RPC from '@/orpc.client'
import * as PartsSys from '@/systems/parts.client'
import * as SettingsClient from '@/systems/settings.client'

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
 * A finished match's feed, replayed here from the raw events the server sends.
 *
 * The same replay the live feed runs, so a past match reads like the present one -- including the suppression
 * patterns, which the server had no way to apply when it enriched these itself.
 *
 * Shared options rather than a hook so the activity panel and the stats panel, which want the same match, agree on
 * the key and replay it once between them.
 */
export function matchEventsQueryOptions(serverId: string, ordinal: number | null) {
	return {
		queryKey: [...RPC.orpc.matchHistory.getMatchEvents.key(), serverId, ordinal],
		queryFn: async () => {
			if (ordinal === null) return null
			const res = RPC.selectLoaded(await RPC.orpc.matchHistory.getMatchEvents.call({ serverId, ordinal }))
			if (!res) return null
			const state = CHAT.getInitialChatState()
			for (const event of res.events) CHAT.handleEvent(state, event, SettingsClient.getSettings()?.chat)
			return { events: state.eventBuffer, previousOrdinal: res.previousOrdinal }
		},
		enabled: ordinal !== null,
		staleTime: Infinity,
	}
}
