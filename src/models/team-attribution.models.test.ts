import { describe, expect, it } from 'vitest'

import type * as CHAT from '@/models/chat.models'
import type * as SM from '@/models/squad.models'
import * as TA from '@/models/team-attribution.models'

const m = (minutes: number) => minutes * 60_000

// thresholds all disabled, so tests of the time replay aren't entangled with eligibility
const OPEN: TA.Settings = { minTimeOnTeamMinutes: 0, minTeamTimeShare: 0.5 }

function makePlayer(eos: string, opts: Partial<SM.Player> = {}): SM.Player {
	return {
		ids: { eos, playerController: `ctrl_${eos}`, username: eos },
		teamId: 1,
		squadId: null,
		isLeader: false,
		isAdmin: false,
		adminGroups: [],
		role: 'Rifleman_01',
		...opts,
	}
}

function makeSquad(squadId: number, teamId: SM.TeamId, creatorEos: string, uniqueId: number): SM.UniqueSquad {
	return { squadId, teamId, creator: creatorEos, uniqueId, squadName: `Squad ${squadId}`, locked: false }
}

let nextId = 1
const base = (time: number) => ({ id: nextId++, time, matchId: 1 })

function reset(time: number, players: SM.Player[], squads: SM.UniqueSquad[] = []): CHAT.EventEnriched {
	return { type: 'RESET', source: 'server-roll', state: { players, squads }, ...base(time) }
}
function connected(time: number, player: SM.Player): CHAT.EventEnriched {
	return { type: 'PLAYER_CONNECTED', player, ...base(time) }
}
function disconnected(time: number, player: SM.Player): CHAT.EventEnriched {
	return { type: 'PLAYER_DISCONNECTED', player, ...base(time) }
}
function changedTeam(time: number, player: SM.Player, from: SM.TeamId, to: SM.TeamId): CHAT.EventEnriched {
	return { type: 'PLAYER_CHANGED_TEAM', player, newTeamId: to, prevTeamId: from, ...base(time) }
}
function joinedSquad(time: number, player: SM.Player, squad: SM.UniqueSquad): CHAT.EventEnriched {
	return { type: 'PLAYER_JOINED_SQUAD', player, uniqueId: squad.uniqueId, squad, ...base(time) }
}
function leftSquad(time: number, player: SM.Player, squad: SM.UniqueSquad): CHAT.EventEnriched {
	return { type: 'PLAYER_LEFT_SQUAD', player, uniqueId: squad.uniqueId, squad, wasLeader: false, ...base(time) }
}
function died(
	time: number,
	attacker: SM.Player,
	victim: SM.Player,
	variant: 'normal' | 'suicide' | 'teamkill' = 'normal',
): CHAT.EventEnriched {
	return { type: 'PLAYER_DIED', attacker, victim, damage: 100, weapon: 'BP_Rifle', variant, ...base(time) }
}
function wounded(
	time: number,
	attacker: SM.Player,
	victim: SM.Player,
	variant: 'normal' | 'suicide' | 'teamkill' = 'normal',
): CHAT.EventEnriched {
	return { type: 'PLAYER_WOUNDED', attacker, victim, damage: 100, weapon: 'BP_Rifle', variant, ...base(time) }
}
// a cheap end-of-match marker: attribution closes open intervals at the last event's time
function endMarker(time: number): CHAT.EventEnriched {
	return { type: 'TEAMS_POLLED_UPDATE', ...base(time) }
}

function attributionOf(result: TA.MatchAttribution, eos: string): TA.PlayerAttribution {
	const entry = result.players.find((p) => p.playerId === eos)
	expect(entry).toBeDefined()
	return entry!
}

describe('computeTeamAttribution time replay', () => {
	it('counts roster-seeded presence until disconnect or match end', () => {
		const a = makePlayer('a', { teamId: 1 })
		const b = makePlayer('b', { teamId: 2 })
		const result = TA.computeTeamAttribution([reset(0, [a, b]), disconnected(m(10), a), endMarker(m(30))], OPEN)

		expect(attributionOf(result, 'a').teamMs).toEqual([m(10), 0])
		expect(attributionOf(result, 'b').teamMs).toEqual([0, m(30)])
		expect(attributionOf(result, 'b').primaryTeamId).toBe(2)
	})

	it('splits time across a team change and attributes the larger side', () => {
		const a = makePlayer('a', { teamId: 1 })
		const result = TA.computeTeamAttribution([reset(0, [a]), changedTeam(m(10), a, 1, 2), endMarker(m(30))], OPEN)

		const attr = attributionOf(result, 'a')
		expect(attr.teamMs).toEqual([m(10), m(20)])
		expect(attr.primaryTeamId).toBe(2)
		expect(attr.share).toBeCloseTo(2 / 3)
	})

	it('closes intervals for players missing from a later definitive roster', () => {
		const a = makePlayer('a', { teamId: 1 })
		const b = makePlayer('b', { teamId: 1 })
		const result = TA.computeTeamAttribution([reset(0, [a, b]), reset(m(10), [a]), endMarker(m(20))], OPEN)

		expect(attributionOf(result, 'a').teamMs).toEqual([m(20), 0])
		expect(attributionOf(result, 'b').teamMs).toEqual([m(10), 0])
	})

	it('counts a mid-match join from its connect time', () => {
		const a = makePlayer('a', { teamId: 1 })
		const b = makePlayer('b', { teamId: 1 })
		const result = TA.computeTeamAttribution([reset(0, [a]), connected(m(15), b), endMarker(m(30))], OPEN)

		expect(attributionOf(result, 'b').teamMs).toEqual([m(15), 0])
	})

	it('seeds the roster from a legacy NEW_GAME state', () => {
		const a = makePlayer('a', { teamId: 2 })
		const event: CHAT.EventEnriched = {
			type: 'NEW_GAME',
			source: 'server-roll',
			layerId: 'some-layer',
			state: { players: [a], squads: [] },
			...base(0),
		}
		const result = TA.computeTeamAttribution([event, endMarker(m(5))], OPEN)
		expect(attributionOf(result, 'a').teamMs).toEqual([0, m(5)])
	})

	it('unfolds server events collapsed under an app event', () => {
		const a = makePlayer('a', { teamId: 1 })
		const appEntry: CHAT.EventEnriched = {
			type: 'APP_EVENT',
			id: 'app-1',
			time: m(10),
			matchId: 1,
			appEvent: {
				type: 'PLAYER_TEAM_CHANGED',
				id: 'app-1',
				time: m(10),
				actor: { type: 'slm-user', userId: 1n },
				serverId: 's1',
				matchId: 1,
				causeId: null,
				instanceId: null,
				targets: ['a'],
			} as any,
			targetPlayers: [a],
			warnSummary: { type: 'players' },
			collapsed: [changedTeam(m(10), a, 1, 2)],
			targetSquadIds: [],
		}
		const result = TA.computeTeamAttribution([reset(0, [a]), appEntry, endMarker(m(30))], OPEN)
		expect(attributionOf(result, 'a').teamMs).toEqual([m(10), m(20)])
	})
})

describe('computeTeamAttribution eligibility', () => {
	// a player who joined a squad and saw combat, so only the threshold under test can exclude them
	function activePlayer(eos: string, teamId: SM.TeamId, squad: SM.UniqueSquad) {
		return makePlayer(eos, { teamId, squadId: squad.squadId })
	}

	it('marks an in-squad combatant with ample time eligible', () => {
		const squad = makeSquad(1, 1, 'a', 100)
		const a = activePlayer('a', 1, squad)
		const b = makePlayer('b', { teamId: 2 })
		const result = TA.computeTeamAttribution([reset(0, [a, b], [squad]), died(m(5), a, b), endMarker(m(30))], {
			minTimeOnTeamMinutes: 10,
			minTeamTimeShare: 0.6,
		})
		const attr = attributionOf(result, 'a')
		expect(attr.exclusionReasons).toEqual([])
		expect(attr.eligible).toBe(true)
		expect(attr.lastSquadByTeam).toEqual([100, null])
	})

	it('excludes players who never joined a squad or never saw combat', () => {
		const squad = makeSquad(1, 1, 'a', 100)
		const a = activePlayer('a', 1, squad)
		const b = makePlayer('b', { teamId: 2 })
		const result = TA.computeTeamAttribution([reset(0, [a, b], [squad]), died(m(5), a, b), endMarker(m(30))], OPEN)

		// a is in a squad and got a kill; b was killed but never joined a squad
		expect(attributionOf(result, 'a').exclusionReasons).toEqual([])
		expect(attributionOf(result, 'b').exclusionReasons).toEqual(['no-squad'])

		// c is in a squad but saw no combat
		const squad2 = makeSquad(1, 2, 'c', 101)
		const c = activePlayer('c', 2, squad2)
		const result2 = TA.computeTeamAttribution([reset(0, [c], [squad2]), endMarker(m(30))], OPEN)
		expect(attributionOf(result2, 'c').exclusionReasons).toEqual(['no-combat'])
	})

	it('tallies scorelines by the live rules: kills on normal, teamkills apart, wounds to the attacker', () => {
		const a = makePlayer('a', { teamId: 1 })
		const b = makePlayer('b', { teamId: 2 })
		const c = makePlayer('c', { teamId: 1 })
		const result = TA.computeTeamAttribution(
			[
				reset(0, [a, b, c]),
				wounded(m(1), a, b),
				died(m(1), a, b),
				died(m(2), a, c, 'teamkill'),
				died(m(3), b, b, 'suicide'),
				endMarker(m(5)),
			],
			OPEN,
		)
		expect(attributionOf(result, 'a').stats).toEqual({ kills: 1, wounds: 1, deaths: 0, teamkills: 1 })
		expect(attributionOf(result, 'b').stats).toEqual({ kills: 0, wounds: 0, deaths: 2, teamkills: 0 })
		expect(attributionOf(result, 'c').stats).toEqual({ kills: 0, wounds: 0, deaths: 1, teamkills: 0 })
	})

	it('a suicide counts combat for the victim only once', () => {
		const a = makePlayer('a', { teamId: 1 })
		const result = TA.computeTeamAttribution([reset(0, [a]), died(m(5), a, a, 'suicide'), endMarker(m(10))], OPEN)
		expect(attributionOf(result, 'a').exclusionReasons).not.toContain('no-combat')
	})

	it('excludes below the minimum time on team', () => {
		const squad = makeSquad(1, 1, 'a', 100)
		const a = activePlayer('a', 1, squad)
		const b = makePlayer('b', { teamId: 2 })
		const result = TA.computeTeamAttribution([reset(0, [a, b], [squad]), died(m(2), a, b), disconnected(m(5), a), endMarker(m(30))], {
			minTimeOnTeamMinutes: 10,
			minTeamTimeShare: 0.5,
		})
		expect(attributionOf(result, 'a').exclusionReasons).toEqual(['low-team-time'])
	})

	it('excludes players who split their time too evenly', () => {
		const squad = makeSquad(1, 1, 'a', 100)
		const a = activePlayer('a', 1, squad)
		const b = makePlayer('b', { teamId: 2 })
		// 16m on team 1, 14m on team 2: share ~0.53
		const result = TA.computeTeamAttribution(
			[reset(0, [a, b], [squad]), died(m(2), a, b), changedTeam(m(16), a, 1, 2), endMarker(m(30))],
			{ minTimeOnTeamMinutes: 10, minTeamTimeShare: 0.6 },
		)
		const attr = attributionOf(result, 'a')
		expect(attr.primaryTeamId).toBe(1)
		expect(attr.exclusionReasons).toEqual(['split-team-time'])
	})

	it('a combat-only ghost has no team time and is excluded', () => {
		const a = makePlayer('a', { teamId: 1 })
		const ghost = makePlayer('g', { teamId: 2 })
		const result = TA.computeTeamAttribution([reset(0, [a]), died(m(5), ghost, a), endMarker(m(10))], OPEN)
		const attr = attributionOf(result, 'g')
		expect(attr.primaryTeamId).toBe(null)
		expect(attr.exclusionReasons).toContain('low-team-time')
	})
})

describe('computeTeamAttribution squad grouping', () => {
	it('tracks the last squad per team and clears it on leave', () => {
		const squad = makeSquad(1, 1, 'a', 100)
		const a = makePlayer('a', { teamId: 1 })
		const result = TA.computeTeamAttribution(
			[reset(0, [a]), joinedSquad(m(5), a, squad), leftSquad(m(10), a, squad), endMarker(m(30))],
			OPEN,
		)
		const attr = attributionOf(result, 'a')
		expect(attr.lastSquadByTeam).toEqual([null, null])
		expect(attr.exclusionReasons).not.toContain('no-squad')
		expect(result.squads.map((s) => s.uniqueId)).toEqual([100])
	})
})
