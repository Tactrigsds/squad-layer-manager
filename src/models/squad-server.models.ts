import * as CHAT from '@/models/chat.models'
import * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'

export type ChatStore = {
	chatState: CHAT.ChatState
	loadedServerId: string | null
	secondaryFilterState: CHAT.SecondaryFilterState
	setSecondaryFilterState(state: CHAT.SecondaryFilterState): void
	handleChatEvents(event: (CHAT.Event | CHAT.LifecycleEvent)[]): void
	// increments every time we modify the chat state
	eventGeneration: number
	// Selected match ordinal for viewing historical events (null = current match)
	selectedMatchOrdinal: number | null
	setSelectedMatchOrdinal(ordinal: number | null): Promise<void>
}

export namespace Select {
	export function state(store: ChatStore) {
		return store.chatState.interpolatedState
	}
	export function events(store: ChatStore) {
		return store.chatState.eventBuffer
	}
	export function playersForTeam(maybeNormedTeamId: MH.NormedTeamId | SM.TeamId) {
		return (store: ChatStore, currentMatch: MH.MatchDetails | undefined): SM.Player[] => {
			if (!currentMatch) return []
			const teamId = MH.getDenormedTeamId(maybeNormedTeamId, currentMatch.ordinal)
			return state(store).players.filter((p) => p.teamId === teamId)
		}
	}
	export function squadsForTeam(maybeNormedTeamId: MH.NormedTeamId | SM.TeamId) {
		return (store: ChatStore, currentMatch: MH.MatchDetails | undefined): SM.UniqueSquad[] => {
			if (!currentMatch) return []
			const teamId = MH.getDenormedTeamId(maybeNormedTeamId, currentMatch.ordinal)
			return state(store).squads.filter((s) => s.teamId === teamId)
		}
	}
	export function teamPlayerCount(maybeNormedTeamId: MH.NormedTeamId | SM.TeamId) {
		return (store: ChatStore, currentMatch: MH.MatchDetails | undefined) => {
			if (!currentMatch) return 0
			const teamId = MH.getDenormedTeamId(maybeNormedTeamId, currentMatch.ordinal)
			let count = 0
			for (const player of state(store).players) {
				if (player.teamId === teamId) count++
			}
			return count
		}
	}
}
