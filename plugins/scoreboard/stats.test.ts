import { describe, expect, it } from 'vitest'

import type * as SM from 'slm/models/squad'
import type * as MatchHistory from 'slm/systems/match-history'

import * as Stats from './stats.ts'

function player(eos: string, teamId: SM.TeamId, squadId: number | null = null): SM.Player {
	return { ids: { eos, username: eos }, teamId, squadId, isLeader: false, isAdmin: false, role: 'Rifleman' }
}

const actor = (className: string, targetType: string | null) => ({ className, instanceId: 1, targetType })

let time = 0
function events(...partials: Record<string, unknown>[]): MatchHistory.MatchEvent[] {
	return partials.map((e) => ({ id: ++time, time: ++time, matchId: 1, ...e }) as unknown as MatchHistory.MatchEvent)
}

const squad = (uniqueId: number, squadId: number, squadName: string, creator: SM.Player) => ({
	uniqueId,
	squadId,
	squadName,
	teamId: creator.teamId,
	locked: false,
	creator: creator.ids.eos,
})

describe('tally', () => {
	const a = player('a', 1, 1)
	const b = player('b', 2)
	const c = player('c', 1)

	it('credits kills to the squad instance that held the squad id at the time', () => {
		const e = player('e', 1, 1)
		const t = Stats.tally(
			events(
				{ type: 'SQUAD_CREATED', creator: a, squad: squad(10, 1, 'ARMOR', a) },
				{ type: 'PLAYER_DIED', variant: 'normal', attacker: a, victim: b },
				{ type: 'SQUAD_DISBANDED', uniqueId: 10, squad: squad(10, 1, 'ARMOR', a) },
				{ type: 'SQUAD_CREATED', creator: e, squad: squad(11, 1, 'INF', e) },
				{ type: 'PLAYER_DIED', variant: 'normal', attacker: a, victim: b },
				{ type: 'PLAYER_DIED', variant: 'normal', attacker: player('d', 2, 4), victim: c },
			),
		)
		expect([...t.squads.values()].map((s) => [s.squadId, s.creatorName, s.kills])).toEqual([
			[1, 'a', 1],
			[1, 'e', 1],
			[4, null, 1],
		])
	})

	it('resets a streak on death and keeps teamkills out of kills', () => {
		const t = Stats.tally(
			events(
				{ type: 'PLAYER_DIED', variant: 'normal', attacker: a, victim: b },
				{ type: 'PLAYER_DIED', variant: 'normal', attacker: a, victim: b },
				{ type: 'PLAYER_DIED', variant: 'normal', attacker: b, victim: a },
				{ type: 'PLAYER_DIED', variant: 'normal', attacker: a, victim: b },
				{ type: 'PLAYER_DIED', variant: 'teamkill', attacker: a, victim: c },
			),
		)
		const tallyA = t.players.get('a')!
		expect(tallyA).toMatchObject({ kills: 3, deaths: 1, longestStreak: 2, teamkills: 1 })
		expect(t.players.get('c')!.deaths).toBe(1)
		expect(t.killTimes.map((times) => times.length)).toEqual([3, 1])
	})

	it('credits vehicle attacks on an unknown side and enemy FOB damage, but not a crash nobody owned', () => {
		const t = Stats.tally(
			events(
				{ type: 'VEHICLE_DAMAGED', variant: null, attacker: a, damage: 400, vehicle: actor('BP_BTR80', 'APC') },
				{ type: 'VEHICLE_DAMAGED', variant: 'teamkill', attacker: a, damage: 900, vehicle: actor('BP_BTR80', 'APC') },
				{ type: 'VEHICLE_DESTROYED', variant: null, cause: 'weapon', attacker: a, vehicle: actor('BP_BTR80', 'APC'), crew: [] },
				{ type: 'VEHICLE_DESTROYED', variant: null, cause: 'collision', attacker: b, vehicle: actor('BP_Loach', 'HELI'), crew: [] },
				{
					type: 'FOB_RADIO_DAMAGED',
					variant: 'normal',
					attacker: a,
					damage: 300,
					bottomedOut: false,
					radio: actor('BP_FOBRadio', 'RADIO'),
				},
				{
					type: 'FOB_RADIO_DAMAGED',
					variant: 'normal',
					attacker: a,
					damage: 150,
					bottomedOut: true,
					radio: actor('BP_FOBRadio', 'RADIO'),
				},
				{
					type: 'FOB_RADIO_DAMAGED',
					variant: 'teamkill',
					attacker: a,
					damage: 500,
					bottomedOut: false,
					radio: actor('BP_FOBRadio', 'RADIO'),
				},
				{
					type: 'FOB_RADIO_DAMAGED',
					variant: 'normal',
					attacker: a,
					damage: null,
					bottomedOut: true,
					radio: actor('BP_FOBRadio', 'RADIO'),
				},
				{ type: 'DEPLOYABLE_DESTROYED', variant: 'normal', attacker: a, deployable: actor('BP_Hab', 'HAB') },
				{ type: 'PLAYER_REVIVED', reviver: c, revived: a },
			),
		)
		expect(t.players.get('a')).toMatchObject({ vehicleDamage: 400, vehicleKills: 1, fobDamage: 450 })
		expect(t.players.get('b')?.vehicleKills ?? 0).toBe(0)
		expect(t.players.get('c')!.revives).toBe(1)
	})
})
