import { z } from 'zod'

import type * as CHAT from '@/models/chat.models'
import * as SM from '@/models/squad.models'

// Which team a historical match's players count for: the team they spent the most time on, replayed from the
// match's event stream. The thresholds below carve marginal players out of the team breakdown chart; carved-out
// players still appear in the full teams view, flagged. Players who never joined a squad or never took part in
// any kill or wound are always carved out.
export const SettingsSchema = z.object({
	minTimeOnTeamMinutes: z
		.number()
		.min(0)
		.prefault(10)
		.describe(
			'Minimum time (minutes) a player must have spent on the team they are attributed to for the team breakdown chart to count them. 0 disables this cutoff.',
		),
	minTeamTimeShare: z
		.number()
		.min(0.5)
		.max(1)
		.prefault(0.6)
		.describe(
			'Minimum fraction of a player\'s total team time spent on the team they are attributed to, for players who switched teams mid-match. 0.6 means "at least 60% of their time on that team". 0.5 disables this cutoff.',
		),
})
export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})

export type ExclusionReason = 'low-team-time' | 'split-team-time' | 'no-squad' | 'no-combat'

export type PlayerAttribution = {
	playerId: SM.PlayerId
	// the last-seen full player record, carrying the grouping facts (name, admin status, discord roles) as they
	// were during the match
	player: SM.Player
	// tracked time on team 1 / team 2, ms
	teamMs: [number, number]
	// the team the player spent the most time on; null when no team time was tracked at all
	primaryTeamId: SM.TeamId | null
	// primary team time over total team time, in [0.5, 1]; null when no team time was tracked
	share: number | null
	exclusionReasons: ExclusionReason[]
	// counted into the breakdown chart. Equivalent to exclusionReasons being empty.
	eligible: boolean
	// squad instance (uniqueId) the player last occupied on each team, for grouping the roster view; null where
	// they ended the match squadless on that team
	lastSquadByTeam: [number | null, number | null]
}

export type MatchAttribution = {
	players: PlayerAttribution[]
	// every squad instance seen during the match, for resolving lastSquadByTeam
	squads: SM.RecentSquad[]
}

type Tracked = {
	player: SM.Player
	teamMs: [number, number]
	present: boolean
	openTeam: SM.TeamId | null
	openSince: number
	everInSquad: boolean
	combatEventCount: number
	lastSquadByTeam: [number | null, number | null]
}

// The events that move attribution state. The feed buffer collapses server events attributed to an SLM action
// under that action's APP_EVENT entry, so those have to be pulled back out; the sort restores chronology across
// that unfolding (server event ids are monotonic).
function relevantEvents(events: readonly CHAT.EventEnriched[]): CHAT.EventEnriched[] {
	const flat: CHAT.EventEnriched[] = []
	for (const event of events) {
		if (event.type === 'APP_EVENT') flat.push(...event.collapsed)
		else flat.push(event)
	}
	return flat.sort((a, b) => a.time - b.time || (typeof a.id === 'number' && typeof b.id === 'number' ? a.id - b.id : 0))
}

export function computeTeamAttribution(events: readonly CHAT.EventEnriched[], settings: Settings): MatchAttribution {
	const tracked = new Map<SM.PlayerId, Tracked>()
	const squads = new Map<number, SM.RecentSquad>()
	let endTime = 0

	const get = (player: SM.Player): Tracked => {
		const id = SM.PlayerIds.getPlayerId(player.ids)
		let entry = tracked.get(id)
		if (!entry) {
			entry = {
				player,
				teamMs: [0, 0],
				present: false,
				openTeam: null,
				openSince: 0,
				everInSquad: false,
				combatEventCount: 0,
				lastSquadByTeam: [null, null],
			}
			tracked.set(id, entry)
		} else {
			entry.player = player
		}
		return entry
	}

	const close = (entry: Tracked, time: number) => {
		if (entry.present && entry.openTeam !== null && time > entry.openSince) {
			entry.teamMs[entry.openTeam - 1] += time - entry.openSince
		}
		entry.openSince = time
	}

	const open = (entry: Tracked, teamId: SM.TeamId | null, time: number) => {
		close(entry, time)
		entry.present = true
		entry.openTeam = teamId
		entry.openSince = time
	}

	const recordSquad = (squad: SM.RecentSquad) => squads.set(squad.uniqueId, SM.toRecentSquad(squad))

	const applyRoster = (roster: SM.UniqueTeams, time: number) => {
		for (const squad of roster.squads) recordSquad(squad)
		const seen = new Set<SM.PlayerId>()
		for (const player of roster.players) {
			seen.add(SM.PlayerIds.getPlayerId(player.ids))
			const entry = get(player)
			if (!entry.present || entry.openTeam !== player.teamId) open(entry, player.teamId, time)
			if (player.squadId !== null && player.teamId !== null) {
				entry.everInSquad = true
				const squad = roster.squads.find((s) => s.teamId === player.teamId && s.squadId === player.squadId)
				if (squad) entry.lastSquadByTeam[player.teamId - 1] = squad.uniqueId
			}
		}
		// the roster is definitive: anyone we thought was present but who is missing from it left while we
		// weren't watching, and their open interval ends here
		for (const [id, entry] of tracked) {
			if (entry.present && !seen.has(id)) {
				close(entry, time)
				entry.present = false
			}
		}
	}

	for (const event of relevantEvents(events)) {
		if (event.time > endTime) endTime = event.time
		switch (event.type) {
			case 'RESET': {
				applyRoster(event.state, event.time)
				break
			}
			case 'NEW_GAME': {
				// legacy matches carried the initial roster here; see server-events.models.ts
				if (event.state) applyRoster(event.state, event.time)
				break
			}
			case 'PLAYER_CONNECTED':
			case 'PLAYER_RECONCILED': {
				open(get(event.player), event.player.teamId, event.time)
				break
			}
			case 'PLAYER_DISCONNECTED': {
				const entry = get(event.player)
				close(entry, event.time)
				entry.present = false
				break
			}
			case 'PLAYER_CHANGED_TEAM': {
				open(get(event.player), event.newTeamId, event.time)
				break
			}
			case 'SQUAD_CREATED': {
				recordSquad(event.squad)
				const entry = get(event.creator)
				entry.everInSquad = true
				entry.lastSquadByTeam[event.squad.teamId - 1] = event.squad.uniqueId
				break
			}
			case 'PLAYER_JOINED_SQUAD': {
				recordSquad(event.squad)
				const entry = get(event.player)
				entry.everInSquad = true
				entry.lastSquadByTeam[event.squad.teamId - 1] = event.squad.uniqueId
				break
			}
			case 'PLAYER_LEFT_SQUAD': {
				const entry = get(event.player)
				if (entry.lastSquadByTeam[event.squad.teamId - 1] === event.squad.uniqueId) {
					entry.lastSquadByTeam[event.squad.teamId - 1] = null
				}
				break
			}
			case 'SQUAD_DISBANDED': {
				for (const entry of tracked.values()) {
					if (entry.lastSquadByTeam[event.squad.teamId - 1] === event.squad.uniqueId) {
						entry.lastSquadByTeam[event.squad.teamId - 1] = null
					}
				}
				break
			}
			case 'PLAYER_DIED':
			case 'PLAYER_WOUNDED': {
				// combat participation, on either end of it. Tracked without opening a presence interval: a combat
				// event is evidence the player existed, not of when they arrived or left.
				get(event.victim).combatEventCount++
				if (event.variant !== 'suicide') get(event.attacker).combatEventCount++
				break
			}
			default:
				break
		}
	}

	const minTimeMs = settings.minTimeOnTeamMinutes * 60_000
	const players: PlayerAttribution[] = []
	for (const [playerId, entry] of tracked) {
		close(entry, endTime)
		const [t1, t2] = entry.teamMs
		const total = t1 + t2
		let primaryTeamId: SM.TeamId | null
		if (total === 0) primaryTeamId = null
		else if (t1 !== t2) primaryTeamId = t1 > t2 ? 1 : 2
		else primaryTeamId = entry.openTeam ?? entry.player.teamId ?? 1
		const primaryMs = primaryTeamId === null ? 0 : entry.teamMs[primaryTeamId - 1]
		const share = total === 0 ? null : primaryMs / total

		const exclusionReasons: ExclusionReason[] = []
		// a player with no tracked team time can never be attributed, whatever the threshold
		if (total === 0 || primaryMs < minTimeMs) exclusionReasons.push('low-team-time')
		if (share !== null && share < settings.minTeamTimeShare) exclusionReasons.push('split-team-time')
		if (!entry.everInSquad) exclusionReasons.push('no-squad')
		if (entry.combatEventCount === 0) exclusionReasons.push('no-combat')

		players.push({
			playerId,
			player: entry.player,
			teamMs: entry.teamMs,
			primaryTeamId,
			share,
			exclusionReasons,
			eligible: exclusionReasons.length === 0,
			lastSquadByTeam: entry.lastSquadByTeam,
		})
	}

	return { players, squads: [...squads.values()] }
}
