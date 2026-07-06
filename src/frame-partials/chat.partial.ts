import type * as FRM from '@/lib/frame'
import * as RSel from '@/lib/reselect'
import * as ZusUtils from '@/lib/zustand'
import * as CHAT from '@/models/chat.models'
import * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import * as RPC from '@/orpc.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SettingsClient from '@/systems/settings.client'
import * as Rx from 'rxjs'

export type ChatSlice = {
	serverId: string
	chatState: CHAT.ChatState
	secondaryFilterState: CHAT.SecondaryFilterState
	handleChatEvents(event: (CHAT.Event | CHAT.LifecycleEvent)[]): void
	// increments every time we modify the chat state
	eventGeneration: number
	// Selected match ordinal for viewing historical events (null = current match)
	selectedMatchOrdinal: number | null
}

export type Store = {
	chat: ChatSlice
}

export type Key = FRM.InstanceKeyOfState<Store>
export type KeyProp = { chat: Key }

export type Args = FRM.SetupArgs<{ serverId: string }, Store, Store>

export function initChat(args: Args) {
	const set = ZusUtils.toPartialSetter(args.set, 'chat')
	const get = ZusUtils.toPartialGetter(args.get, 'chat')
	const serverId = args.input.serverId

	set(
		{
			serverId,
			chatState: CHAT.getInitialChatState(),
			secondaryFilterState: 'DEFAULT',
			eventGeneration: 0,
			selectedMatchOrdinal: null,
			handleChatEvents(events) {
				const config = SettingsClient.getSettings()
				set(state => {
					let chatState = state.chatState
					// this is done to cache break the selectors
					chatState.interpolatedState = CHAT.InterpolableState.clone(chatState.interpolatedState)
					for (const event of events) {
						CHAT.handleEvent(chatState, event, config?.chat)
					}
					return { chatState, eventGeneration: state.eventGeneration + 1 }
				})
			},
		} satisfies ChatSlice,
	)

	let previouslyConnected = false
	const chatDisconnected$ = new Rx.Subject<CHAT.ConnectionErrorEvent>()

	const chatEvent$ = RPC.observe(
		() => {
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
	).pipe(Rx.tap({ next: () => (previouslyConnected = true) }))

	args.sub.add(
		Rx.merge(chatEvent$, chatDisconnected$.pipe(Rx.map(e => [e]))).subscribe(events => {
			get().handleChatEvents(events as (CHAT.Event | CHAT.LifecycleEvent)[])
		}),
	)
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
	export function selectedMatchOrdinal(store: Store) {
		return store.chat.selectedMatchOrdinal
	}
	const currentMatchArg = (_store: Store, currentMatch: MH.MatchDetails | undefined) => currentMatch
	export const playersForTeam = RSel.memoizeFactory((maybeNormedTeamId: MH.NormedTeamId | SM.TeamId) =>
		RSel.createDeepSelector(
			[(store: Store) => chatState(store).players, currentMatchArg],
			(players, currentMatch): SM.Player[] => {
				if (!currentMatch) return []
				const teamId = MH.getDenormedTeamId(maybeNormedTeamId, currentMatch.ordinal)
				return players.filter((p) => p.teamId === teamId)
			},
		)
	)
	export const squadsForTeam = RSel.memoizeFactory((maybeNormedTeamId: MH.NormedTeamId | SM.TeamId) =>
		RSel.createDeepSelector(
			[(store: Store) => chatState(store).squads, currentMatchArg],
			(squads, currentMatch): SM.UniqueSquad[] => {
				if (!currentMatch) return []
				const teamId = MH.getDenormedTeamId(maybeNormedTeamId, currentMatch.ordinal)
				return squads.filter((s) => s.teamId === teamId)
			},
		)
	)
	export const teamPlayerCount = RSel.memoizeFactory((maybeNormedTeamId: MH.NormedTeamId | SM.TeamId) =>
		RSel.createSelector(
			[(store: Store) => chatState(store).players, currentMatchArg],
			(players, currentMatch) => {
				if (!currentMatch) return 0
				const teamId = MH.getDenormedTeamId(maybeNormedTeamId, currentMatch.ordinal)
				let count = 0
				for (const player of players) {
					if (player.teamId === teamId) count++
				}
				return count
			},
		)
	)
	// true when SLM (re)started mid-match: a fresh RCON connection (reconnected === false) within the current
	// match means we missed the events preceding the restart, so per-player combat stats are incomplete.
	// not memoized on the buffer ref (it's mutated in place); the caller re-runs it on every store change.
	export function statsMayBeInaccurate(store: Store, currentMatch: MH.MatchDetails | undefined): boolean {
		if (!currentMatch) return false
		for (const event of chatEvents(store)) {
			if (event.type === 'RCON_CONNECTED' && !event.reconnected && event.matchId === currentMatch.historyEntryId) {
				return true
			}
		}
		return false
	}
	export function overallKds(store: Store) {
		const events = chatEvents(store)
		let team1Kills = 0
		let team1Deaths = 0
		let team2Kills = 0
		let team2Deaths = 0

		for (const event of events) {
			if (event.type === 'PLAYER_DIED') {
				const victimTeam = event.victim.teamId
				const attackerTeam = event.attacker.teamId

				if (victimTeam === 1) {
					team1Deaths++
				} else if (victimTeam === 2) {
					team2Deaths++
				}

				if (event.variant === 'normal') {
					if (attackerTeam === 1) {
						team1Kills++
					} else if (attackerTeam === 2) {
						team2Kills++
					}
				}
			}
		}

		const team1Ratio = team1Deaths === 0
			? (team1Kills > 0 ? 999 : 0)
			: team1Kills / team1Deaths
		const team2Ratio = team2Deaths === 0
			? (team2Kills > 0 ? 999 : 0)
			: team2Kills / team2Deaths

		return { team1Ratio, team2Ratio }
	}
}

export namespace Actions {
	export function setSecondaryFilterState(stores: KeyProp, state: CHAT.SecondaryFilterState) {
		ZusUtils.toPartialStore(stores.chat, 'chat').setState({ secondaryFilterState: state })
	}

	export async function setSelectedMatchOrdinal(stores: KeyProp, ordinal: number | null) {
		const chat = ZusUtils.toPartialStore(stores.chat, 'chat')
		const currentMatch = await MatchHistoryClient.currentMatch$(chat.getState().serverId).getValue()
		chat.setState({ selectedMatchOrdinal: currentMatch?.ordinal === ordinal ? null : ordinal })
	}
}
