import { describe, expect, it } from 'vitest'

import type * as CHAT from '@/models/chat.models'
import * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'

function player(eos: string, teamId: SM.TeamId | null): SM.Player {
	return {
		ids: { eos, playerController: `ctrl_${eos}`, username: eos },
		teamId,
		squadId: null,
		isLeader: false,
		isAdmin: false,
		adminGroups: [],
		role: 'Rifleman_01',
	}
}

const a1 = player('a1', 1)
const a2 = player('a2', 1)
const b1 = player('b1', 2)
const unknown = player('u', null)

let nextId = 0
function combat(
	type: 'PLAYER_DIED' | 'PLAYER_WOUNDED',
	victim: SM.Player,
	attacker: SM.Player,
	opts: { variant?: 'normal' | 'suicide' | 'teamkill'; matchId?: number } = {},
): CHAT.EventEnriched {
	nextId++
	return {
		type,
		id: nextId,
		time: 100 + nextId,
		matchId: opts.matchId ?? 1,
		victim,
		attacker,
		damage: 100,
		weapon: 'rifle',
		variant: opts.variant ?? 'normal',
	} as unknown as CHAT.EventEnriched
}

describe('tallyCombatStats', () => {
	it('credits a kill to the attacker’s team and the death to the victim’s', () => {
		const stats = MH.tallyCombatStats([combat('PLAYER_DIED', b1, a1), combat('PLAYER_DIED', a1, b1), combat('PLAYER_DIED', a2, b1)])
		expect(stats.team1).toEqual({ kills: 1, wounds: 0, deaths: 2 })
		expect(stats.team2).toEqual({ kills: 2, wounds: 0, deaths: 1 })
	})

	it('counts wounds dealt without counting them as deaths', () => {
		const stats = MH.tallyCombatStats([combat('PLAYER_WOUNDED', b1, a1), combat('PLAYER_WOUNDED', b1, a1), combat('PLAYER_DIED', b1, a1)])
		expect(stats.team1).toEqual({ kills: 1, wounds: 2, deaths: 0 })
		expect(stats.team2).toEqual({ kills: 0, wounds: 0, deaths: 1 })
	})

	it('takes a teamkill or a suicide as a death nobody is credited with', () => {
		const stats = MH.tallyCombatStats([
			combat('PLAYER_DIED', a2, a1, { variant: 'teamkill' }),
			combat('PLAYER_DIED', a1, a1, { variant: 'suicide' }),
			combat('PLAYER_WOUNDED', a2, a1, { variant: 'teamkill' }),
		])
		expect(stats.team1).toEqual({ kills: 0, wounds: 0, deaths: 2 })
		expect(stats.team2).toEqual({ kills: 0, wounds: 0, deaths: 0 })
	})

	it('counts a player of no known team towards neither side, at either end of the kill', () => {
		const stats = MH.tallyCombatStats([combat('PLAYER_DIED', unknown, a1), combat('PLAYER_DIED', b1, unknown)])
		expect(stats.team1).toEqual({ kills: 1, wounds: 0, deaths: 0 })
		expect(stats.team2).toEqual({ kills: 0, wounds: 0, deaths: 1 })
	})

	it('scopes the walk to one match when given a match id, and spans them all when not', () => {
		const events = [combat('PLAYER_DIED', b1, a1, { matchId: 1 }), combat('PLAYER_DIED', b1, a1, { matchId: 2 })]
		expect(MH.tallyCombatStats(events, 2).team1.kills).toBe(1)
		expect(MH.tallyCombatStats(events).team1.kills).toBe(2)
	})

	it('reads a match nothing was recorded for as having no combat', () => {
		expect(MH.hasCombat(MH.tallyCombatStats([]))).toBe(false)
		expect(MH.hasCombat(MH.tallyCombatStats([combat('PLAYER_DIED', b1, a1)]))).toBe(true)
		// a teamkill is nobody's kill, but it is still a death, so the match did happen
		expect(MH.hasCombat(MH.tallyCombatStats([combat('PLAYER_DIED', a2, a1, { variant: 'teamkill' })]))).toBe(true)
	})
})
