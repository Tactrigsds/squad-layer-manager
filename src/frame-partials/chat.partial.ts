import type * as FRM from '@/lib/frame'
import * as RSel from '@/lib/reselect'
import * as Rx from '@/lib/rxjs'
import * as Zus from '@/lib/zustand'
import * as CHAT from '@/models/chat.models'
import * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import * as RPC from '@/orpc.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SettingsClient from '@/systems/settings.client'

export type ChatSlice = {
	serverId: string
	chatState: CHAT.ChatState
	secondaryFilterState: CHAT.SecondaryFilterState
	// ANDed on top of secondaryFilterState -- restricts the feed to events involving the teams panel's current selection
	selectedOnly: boolean
	handleChatEvents(event: (CHAT.Event | CHAT.LifecycleEvent)[]): void
	// increments every time we modify the chat state
	eventGeneration: number
	// Selected match ordinal for viewing historical events (null = current match)
	selectedMatchOrdinal: number | null
	// which body the activity panel shows while a historical match is selected; meaningless when live
	historicalView: 'feed' | 'teams'
}

export type Store = {
	chat: ChatSlice
}

export type Key = FRM.InstanceKeyOfState<Store>
export type KeyProp = { chat: Key }

export type Args = FRM.SetupArgs<{ serverId: string }, Store, Store>

export function initChat(args: Args) {
	const set = Zus.toPartialSetter(args.set, 'chat')
	const get = Zus.toPartialGetter(args.get, 'chat')
	const serverId = args.input.serverId

	set({
		serverId,
		chatState: CHAT.getInitialChatState(),
		secondaryFilterState: 'DEFAULT',
		selectedOnly: false,
		eventGeneration: 0,
		selectedMatchOrdinal: null,
		historicalView: 'feed',
		handleChatEvents(events) {
			const config = SettingsClient.getSettings()
			set((state) => {
				const chatState = state.chatState
				chatState.interpolatedState = CHAT.InterpolableState.beginBatch(chatState.interpolatedState)
				for (const event of events) {
					CHAT.handleEvent(chatState, event, config?.chat)
				}
				return { chatState, eventGeneration: state.eventGeneration + 1 }
			})
		},
	} satisfies ChatSlice)

	// Live events arrive one per message, and every batch costs each reader of the chat state a recompute, so they are
	// held for up to LIVE_EVENT_BATCH_MS and applied together. A lifecycle event (the start or end of a sync, a
	// connection change) is applied straight away, behind whatever is held.
	let held: (CHAT.Event | CHAT.LifecycleEvent)[] = []
	let flushTimer: ReturnType<typeof setTimeout> | null = null
	function flushHeld() {
		if (flushTimer !== null) {
			clearTimeout(flushTimer)
			flushTimer = null
		}
		if (held.length === 0) return
		const events = held
		held = []
		get().handleChatEvents(events)
	}
	function receive(events: (CHAT.Event | CHAT.LifecycleEvent)[]) {
		for (const event of events) held.push(event)
		if (events.some(isLifecycleEvent)) flushHeld()
		else if (flushTimer === null) flushTimer = setTimeout(flushHeld, LIVE_EVENT_BATCH_MS)
	}
	args.cleanup.push(() => {
		if (flushTimer !== null) clearTimeout(flushTimer)
	})

	let previouslyConnected = false
	const chatDisconnected$ = new Rx.Subject<CHAT.ConnectionErrorEvent>()

	const chatEvent$ = RPC.observe(
		'squadServer.watchChatEvents',
		() => {
			// the resume cursor has to count the events still held, or the server would send them again
			flushHeld()
			const eventBuffer = get().chatState.eventBuffer
			return RPC.orpc.squadServer.watchChatEvents.call({
				lastEventId: CHAT.lastServerEventId(eventBuffer),
				serverId,
			})
		},
		{
			onError: () => {
				chatDisconnected$.next({
					type: 'CONNECTION_ERROR',
					code: previouslyConnected ? 'CONNECTION_LOST' : 'RECONNECT_FAILED',
					time: Date.now(),
				})
			},
		},
	).pipe(RPC.dropUnavailable(), Rx.tap({ next: () => (previouslyConnected = true) }))

	args.cleanup.push(
		Rx.merge(chatEvent$, chatDisconnected$.pipe(Rx.map((e) => [e]))).subscribe((events) => {
			receive(events as (CHAT.Event | CHAT.LifecycleEvent)[])
		}),
	)
}

const LIVE_EVENT_BATCH_MS = 100

function isLifecycleEvent(event: CHAT.Event | CHAT.LifecycleEvent): event is CHAT.LifecycleEvent {
	switch (event.type) {
		case 'INIT':
		case 'SYNCED':
		case 'CONNECTION_ERROR':
		case 'CHAT_RECONNECTED':
			return true
		default:
			return false
	}
}

export namespace Sel {
	export function chatState(store: Store) {
		return store.chat.chatState.interpolatedState
	}
	export function chatEvents(store: Store) {
		return store.chat.chatState.eventBuffer
	}
	export function secondaryFilterState(store: Store) {
		return store.chat.secondaryFilterState
	}
	export function selectedOnly(store: Store) {
		return store.chat.selectedOnly
	}
	export function selectedMatchOrdinal(store: Store) {
		return store.chat.selectedMatchOrdinal
	}
	export function historicalView(store: Store) {
		return store.chat.historicalView
	}
	// the match the dashboard is showing: the live one, or the historical one picked out of recent matches
	export function displayMatch(store: Store, currentMatch: MH.MatchDetails | undefined, recentMatches: readonly MH.MatchDetails[]) {
		const ordinal = selectedMatchOrdinal(store)
		if (ordinal === null) return currentMatch
		return recentMatches.find((m) => m.ordinal === ordinal)
	}

	const currentMatchArg = (_store: Store, currentMatch: MH.MatchDetails | undefined) => currentMatch

	// The interpolated state keys players and squads by id, since that is what the event pipeline looks them up by.
	// The UI wants lists, so they are materialized here, once per interpolated-state change rather than per read.
	export const players = RSel.createSelector([(store: Store) => chatState(store).players], (players) => [...players.values()])
	// sorted here because this is the only place the order is wanted: the teams panel's squad filter lists them
	export const squads = RSel.createSelector([(store: Store) => chatState(store).squads], (squads) =>
		[...squads.values()].sort((a, b) => a.squadId - b.squadId),
	)

	export const playersForTeam = RSel.memoizeFactory((maybeNormedTeamId: MH.NormedTeamId | SM.TeamId) =>
		RSel.createDeepSelector([players, currentMatchArg], (players, currentMatch): SM.Player[] => {
			if (!currentMatch) return []
			const teamId = MH.getDenormedTeamId(maybeNormedTeamId, currentMatch.ordinal)
			return players.filter((p) => p.teamId === teamId)
		}),
	)

	// the live roster entry, i.e. only resolves while the player is connected. Callers that just need to put a name or
	// an id on screen want recentPlayer instead; this one's emptiness is also read as "is offline".
	export function player(playerId: SM.PlayerId) {
		return (store: Store) => chatState(store).players.get(playerId)
	}

	export const recentPlayers = RSel.createSelector([(store: Store) => chatState(store).recentPlayers], (recent) => [...recent.values()])

	// resolves anyone who has taken part in the current match, connected or not
	export function recentPlayer(playerId: SM.PlayerId) {
		return (store: Store) => CHAT.InterpolableState.findRecentPlayer(chatState(store), playerId)
	}

	export const recentSquads = RSel.createSelector([(store: Store) => chatState(store).recentSquads], (recent) => [...recent.values()])

	// resolves any squad instance from the current match, disbanded or not. Its emptiness is not a "disbanded" test --
	// use squads/squad for that.
	export function recentSquad(uniqueSquadId: number) {
		return (store: Store) => CHAT.InterpolableState.findRecentSquad(chatState(store), uniqueSquadId)
	}

	export const squadsForTeam = RSel.memoizeFactory((maybeNormedTeamId: MH.NormedTeamId | SM.TeamId) =>
		RSel.createDeepSelector([squads, currentMatchArg], (squads, currentMatch): SM.UniqueSquad[] => {
			if (!currentMatch) return []
			const teamId = MH.getDenormedTeamId(maybeNormedTeamId, currentMatch.ordinal)
			return squads.filter((s) => s.teamId === teamId)
		}),
	)
	export const teamPlayerCount = RSel.memoizeFactory((maybeNormedTeamId: MH.NormedTeamId | SM.TeamId) =>
		RSel.createSelector([(store: Store) => chatState(store).players, currentMatchArg], (players, currentMatch) => {
			if (!currentMatch) return 0
			const teamId = MH.getDenormedTeamId(maybeNormedTeamId, currentMatch.ordinal)
			let count = 0
			for (const player of players.values()) {
				if (player.teamId === teamId) count++
			}
			return count
		}),
	)
	// true when SLM (re)started mid-match: a fresh RCON connection (reconnected === false) within the current
	// match means we missed the events preceding the restart, so per-player combat stats are incomplete.
	export function statsMayBeInaccurate(store: Store, currentMatch: MH.MatchDetails | undefined): boolean {
		return !!currentMatch && store.chat.chatState.freshConnectionMatchId === currentMatch.historyEntryId
	}

	// The current match's entries involving one player, for a details window. Each call makes a selector with a cache
	// of its own, which scans only the entries added since it last ran.
	export function playerFeedEvents(playerId: SM.PlayerId) {
		const filter = CHAT.createBufferFilter()
		return (store: Store, currentMatch: MH.MatchDetails | undefined): CHAT.EventEnriched[] => {
			const matchId = currentMatch?.historyEntryId
			if (matchId === undefined) return NO_EVENTS
			return filter(store.chat.chatState, (e) => e.matchId === matchId && (e.type === 'NEW_GAME' || CHAT.hasAssocPlayer(e, playerId)), [
				matchId,
			])
		}
	}

	// The current match's entries for one squad instance, for a details window. See playerFeedEvents.
	export function squadFeedEvents(uniqueSquadId: number) {
		const filter = CHAT.createBufferFilter()
		return (store: Store, currentMatch: MH.MatchDetails | undefined): CHAT.EventEnriched[] => {
			const matchId = currentMatch?.historyEntryId
			if (matchId === undefined) return NO_EVENTS
			return filter(store.chat.chatState, (e) => e.matchId === matchId && CHAT.isSquadFeedEvent(e, uniqueSquadId, false), [matchId])
		}
	}
}

const NO_EVENTS: CHAT.EventEnriched[] = []

export namespace Actions {
	export function setSecondaryFilterState(stores: KeyProp, state: CHAT.SecondaryFilterState) {
		Zus.toPartialStore(stores.chat, 'chat').setState({ secondaryFilterState: state })
	}

	export function setSelectedOnly(stores: KeyProp, selectedOnly: boolean) {
		Zus.toPartialStore(stores.chat, 'chat').setState({ selectedOnly })
	}

	export async function setSelectedMatchOrdinal(stores: KeyProp, ordinal: number | null) {
		const chat = Zus.toPartialStore(stores.chat, 'chat')
		const currentMatch = await MatchHistoryClient.currentMatch$(chat.getState().serverId).getValue()
		const resolved = currentMatch?.ordinal === ordinal ? null : ordinal
		// the teams view survives browsing between historical matches, but live always lands on the feed
		chat.setState({ selectedMatchOrdinal: resolved, ...(resolved === null ? { historicalView: 'feed' as const } : {}) })
	}

	export function setHistoricalView(stores: KeyProp, view: ChatSlice['historicalView']) {
		Zus.toPartialStore(stores.chat, 'chat').setState({ historicalView: view })
	}
}
