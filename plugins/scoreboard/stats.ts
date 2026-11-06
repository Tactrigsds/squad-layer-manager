import type * as SM from 'slm/models/squad'
import type * as MatchHistory from 'slm/systems/match-history'

// Tallies a match's activity feed into per-player and per-squad counts, and the timelines the charts draw.
// Counting follows the match history scoreline: a kill is a PLAYER_DIED with a 'normal' variant, credited to the
// attacker's team at the time.

export type PlayerTally = {
	id: SM.PlayerId
	name: string
	teamId: SM.TeamId | null
	kills: number
	deaths: number
	downs: number
	teamkills: number
	revives: number
	vehicleKills: number
	vehicleDamage: number
	deployableKills: number
	longestStreak: number
	currentStreak: number
}

export type SquadTally = { uniqueId: number; name: string; teamId: SM.TeamId; kills: number }

export type TicketSample = { time: number; tickets: [number, number] }

export type MatchTally = {
	players: Map<SM.PlayerId, PlayerTally>
	squads: Map<number, SquadTally>
	// event times, in order, per team slot (index 0 is team 1)
	killTimes: [number[], number[]]
	tickets: TicketSample[]
}

export function tally(events: readonly MatchHistory.MatchEvent[]): MatchTally {
	const players = new Map<SM.PlayerId, PlayerTally>()
	const squads = new Map<number, SquadTally>()
	// the squad instance each (team, squad id) slot currently holds, since squad ids are reused within a match
	const squadSlots = new Map<string, number>()
	const killTimes: MatchTally['killTimes'] = [[], []]
	const tickets: TicketSample[] = []

	const playerOf = (player: SM.Player): PlayerTally => {
		const id = player.ids.eos
		let entry = players.get(id)
		if (!entry) {
			entry = {
				id,
				name: player.ids.username,
				teamId: player.teamId,
				kills: 0,
				deaths: 0,
				downs: 0,
				teamkills: 0,
				revives: 0,
				vehicleKills: 0,
				vehicleDamage: 0,
				deployableKills: 0,
				longestStreak: 0,
				currentStreak: 0,
			}
			players.set(id, entry)
		} else if (player.teamId !== null) {
			entry.teamId = player.teamId
		}
		return entry
	}

	const trackSquad = (squad: { uniqueId: number; squadId: number; squadName: string; teamId: SM.TeamId }) => {
		squadSlots.set(`${squad.teamId}:${squad.squadId}`, squad.uniqueId)
		const existing = squads.get(squad.uniqueId)
		if (existing) existing.name = squad.squadName
		else squads.set(squad.uniqueId, { uniqueId: squad.uniqueId, name: squad.squadName, teamId: squad.teamId, kills: 0 })
	}

	// a squad the feed never named, such as one formed before SLM started, is keyed below every real uniqueId
	let unnamedSquads = 0
	const squadOf = (player: SM.Player): SquadTally | undefined => {
		if (player.teamId === null || player.squadId === null) return undefined
		const slot = `${player.teamId}:${player.squadId}`
		let uniqueId = squadSlots.get(slot)
		if (uniqueId === undefined) {
			uniqueId = -++unnamedSquads
			squadSlots.set(slot, uniqueId)
			squads.set(uniqueId, { uniqueId, name: `Squad ${player.squadId}`, teamId: player.teamId, kills: 0 })
		}
		return squads.get(uniqueId)
	}

	for (const event of events) {
		switch (event.type) {
			case 'RESET':
				for (const squad of event.state.squads) trackSquad(squad)
				break
			case 'SQUAD_CREATED':
			case 'SQUAD_RENAMED':
			case 'PLAYER_JOINED_SQUAD':
			case 'PLAYER_PROMOTED_TO_LEADER':
				trackSquad(event.squad)
				break
			case 'TICKETS_CHANGED':
				tickets.push({ time: event.time, tickets: [event.team1Tickets, event.team2Tickets] })
				break
			case 'PLAYER_DIED': {
				const victim = playerOf(event.victim)
				victim.deaths++
				victim.currentStreak = 0
				if (event.variant === 'teamkill') {
					playerOf(event.attacker).teamkills++
					break
				}
				if (event.variant !== 'normal') break
				const attacker = playerOf(event.attacker)
				attacker.kills++
				attacker.currentStreak++
				if (attacker.currentStreak > attacker.longestStreak) attacker.longestStreak = attacker.currentStreak
				const squad = squadOf(event.attacker)
				if (squad) squad.kills++
				const slot = (event.attacker.teamId ?? 0) - 1
				if (slot === 0 || slot === 1) killTimes[slot].push(event.time)
				break
			}
			case 'PLAYER_REVIVED':
				playerOf(event.reviver).revives++
				break
			case 'PLAYER_WOUNDED':
				if (event.variant === 'normal') playerOf(event.attacker).downs++
				break
			case 'VEHICLE_DAMAGED':
				if (creditsAttacker(event.variant)) playerOf(event.attacker).vehicleDamage += event.damage
				break
			case 'VEHICLE_DESTROYED':
				// a crash with no known owner is most often the pilot's own empty vehicle
				if (event.variant === null && event.cause === 'collision') break
				if (event.attacker && creditsAttacker(event.variant)) playerOf(event.attacker).vehicleKills++
				break
			case 'DEPLOYABLE_DESTROYED':
				if (event.attacker && creditsAttacker(event.variant) && event.deployable.targetType === 'HAB') {
					playerOf(event.attacker).deployableKills++
				}
				break
			// a radio is never destroyed in the log, only worn down to its minimum health
			case 'FOB_RADIO_DAMAGED':
				if (event.attacker && event.bottomedOut && creditsAttacker(event.variant)) playerOf(event.attacker).deployableKills++
				break
		}
	}

	return { players, squads, killTimes, tickets }
}

// A null variant is an attack on something whose owning side is unknown, which is still credited to the attacker.
function creditsAttacker(variant: 'normal' | 'suicide' | 'teamkill' | null) {
	return variant === 'normal' || variant === null
}

export type Ranked<T> = { item: T; value: number }

/** The `size` highest of `items` by `value`, leaving out any whose value is not above zero. */
export function top<T>(items: Iterable<T>, value: (item: T) => number, size: number): Ranked<T>[] {
	const ranked: Ranked<T>[] = []
	for (const item of items) {
		const v = value(item)
		if (v > 0) ranked.push({ item, value: v })
	}
	ranked.sort((a, b) => b.value - a.value)
	return ranked.slice(0, size)
}

/** Kills per death, counting a player who never died as having died once. */
export function kd(player: PlayerTally): number {
	return player.kills / Math.max(1, player.deaths)
}
