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
	export function chatState(store: ChatStore) {
		return store.chatState.interpolatedState
	}
	export function chatEvents(store: ChatStore) {
		return store.chatState.eventBuffer
	}
	export function playersForTeam(maybeNormedTeamId: MH.NormedTeamId | SM.TeamId) {
		return (store: ChatStore, currentMatch: MH.MatchDetails | undefined): SM.Player[] => {
			if (!currentMatch) return []
			const teamId = MH.getDenormedTeamId(maybeNormedTeamId, currentMatch.ordinal)
			return chatState(store).players.filter((p) => p.teamId === teamId)
		}
	}
	export function squadsForTeam(maybeNormedTeamId: MH.NormedTeamId | SM.TeamId) {
		return (store: ChatStore, currentMatch: MH.MatchDetails | undefined): SM.UniqueSquad[] => {
			if (!currentMatch) return []
			const teamId = MH.getDenormedTeamId(maybeNormedTeamId, currentMatch.ordinal)
			return chatState(store).squads.filter((s) => s.teamId === teamId)
		}
	}
	export function teamPlayerCount(maybeNormedTeamId: MH.NormedTeamId | SM.TeamId) {
		return (store: ChatStore, currentMatch: MH.MatchDetails | undefined) => {
			if (!currentMatch) return 0
			const teamId = MH.getDenormedTeamId(maybeNormedTeamId, currentMatch.ordinal)
			let count = 0
			for (const player of chatState(store).players) {
				if (player.teamId === teamId) count++
			}
			return count
		}
	}
	export function overallKds(store: ChatStore) {
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
