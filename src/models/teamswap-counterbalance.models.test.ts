import { describe, expect, it } from 'vitest'

import type * as MH from '@/models/match-history.models'
import * as PG from '@/models/player-groupings.models'
import type * as SM from '@/models/squad.models'
import * as TSWCB from '@/models/teamswap-counterbalance.models'

const SETTINGS: TSWCB.Settings = TSWCB.SettingsSchema.parse({ enabled: true })

const GROUPINGS: PG.PlayerGroupings = {
	Clan: { rules: [{ type: 'tag-regex', pattern: '^TT$', group: 'TT' }], groups: {} },
	Membership: { rules: [{ type: 'name-regex', pattern: '^reg', group: 'Regulars' }], groups: {} },
}

type PlayerSpec = { team: MH.NormedTeamId; party?: string; kills?: number; deaths?: number; wounds?: number; name?: string }

function player(playerId: SM.PlayerId, spec: PlayerSpec): TSWCB.Candidate {
	const name = spec.name ?? playerId
	return {
		playerId,
		team: spec.team,
		partyId: spec.party ?? null,
		stats: { kills: spec.kills ?? 0, deaths: spec.deaths ?? 0, wounds: spec.wounds ?? 0 },
		facts: PG.playerFacts({ ids: { username: name }, isAdmin: false }, []),
	}
}

// `n` filler players on a team, ranked behind anyone with stats under the default lowest-K/D preference
function filler(team: MH.NormedTeamId, n: number, prefix: string): TSWCB.Candidate[] {
	return Array.from({ length: n }, (_, i) => player(`${prefix}${i}`, { team, kills: 50, deaths: 1 }))
}

function compute(overrides: Partial<TSWCB.Input> & Pick<TSWCB.Input, 'players' | 'manualSwaps'>) {
	return TSWCB.compute({ settings: SETTINGS, groupings: GROUPINGS, skipped: new Set(), pending: new Set(), ...overrides })
}

describe('counterbalance compute', () => {
	it('offsets admin swaps with the lowest K/D players from the larger side', () => {
		const players = [
			...filler('A', 3, 'a'),
			...filler('B', 3, 'b'),
			player('low', { team: 'B', kills: 1, deaths: 4 }),
			player('mid', { team: 'B', kills: 4, deaths: 4 }),
		]
		// 4v5, and two admin swaps B -> A make 6v3, so one player goes from A to B
		const manualSwaps = new Map<SM.PlayerId, MH.NormedTeamId>([
			['b0', 'A'],
			['b1', 'A'],
		])
		const result = compute({ players: [...players, player('weak', { team: 'A', kills: 0, deaths: 9 })], manualSwaps })
		expect([...result.swaps]).toEqual([['weak', 'B']])
		expect(result.shortfall).toBe(0)
	})

	it('queues nothing when there are no admin swaps, even on uneven teams', () => {
		const result = compute({ players: [...filler('A', 6, 'a'), ...filler('B', 2, 'b')], manualSwaps: new Map() })
		expect(result.swaps.size).toBe(0)
	})

	it('aims for even teams overall, not only to cancel the admin swaps', () => {
		// 41v39, three admin swaps A -> B make 38v42, so two players go from B to A
		const players = [...filler('A', 41, 'a'), ...filler('B', 37, 'b'), player('x', { team: 'B' }), player('y', { team: 'B' })]
		const manualSwaps = new Map<SM.PlayerId, MH.NormedTeamId>([
			['a0', 'B'],
			['a1', 'B'],
			['a2', 'B'],
		])
		const result = compute({ players, manualSwaps })
		expect(new Set(result.swaps.keys())).toEqual(new Set(['x', 'y']))
		expect([...result.swaps.values()].every((team) => team === 'A')).toBe(true)
	})

	it('swaps a party whole, and passes over one that would overshoot', () => {
		const players = [
			...filler('A', 4, 'a'),
			...filler('B', 4, 'b'),
			player('p1', { team: 'A', party: '#1' }),
			player('p2', { team: 'A', party: '#1' }),
			player('p3', { team: 'A', party: '#1' }),
			player('q1', { team: 'A', party: '#2' }),
			player('q2', { team: 'A', party: '#2', kills: 1, deaths: 1 }),
		]
		// 9v4 plus two admin swaps B -> A: 11v2, so four go back. #1 (3) fits, then #2 (2) would overshoot to 5
		const manualSwaps = new Map<SM.PlayerId, MH.NormedTeamId>([
			['b0', 'A'],
			['b1', 'A'],
		])
		const result = compute({ players, manualSwaps })
		expect(result.swaps.has('p1') && result.swaps.has('p2') && result.swaps.has('p3')).toBe(true)
		expect(result.swaps.has('q1') || result.swaps.has('q2')).toBe(false)
		expect(result.swaps.size).toBe(4)
	})

	it('skips a whole party when any member is excluded', () => {
		const settings = TSWCB.SettingsSchema.parse({ enabled: true, neverPickAbove: { kills: 10 } })
		const players = [
			...filler('B', 2, 'b'),
			player('p1', { team: 'A', party: '#1' }),
			player('p2', { team: 'A', party: '#1', kills: 11, deaths: 1 }),
			player('solo', { team: 'A', kills: 5, deaths: 5 }),
			player('other', { team: 'A', kills: 9, deaths: 1 }),
		]
		const manualSwaps = new Map<SM.PlayerId, MH.NormedTeamId>([['b0', 'A']])
		// 5v1 after the swap, so two go to B. Party #1 is skipped whole, because p2 is over the kill limit
		const result = compute({ settings, players, manualSwaps })
		expect(new Set(result.swaps.keys())).toEqual(new Set(['solo', 'other']))
	})

	it('never picks excluded groups and ranks preferred groups first', () => {
		const settings = TSWCB.SettingsSchema.parse({
			enabled: true,
			neverPickGroups: [{ grouping: 'Clan', group: 'TT' }],
			pickFirst: [
				{ type: 'group', grouping: 'Membership', group: 'Regulars' },
				{ type: 'kd', order: 'lowest' },
			],
		})
		const players = [
			...filler('B', 2, 'b'),
			player('clan', { team: 'A', name: 'TTguy' }),
			player('regular', { team: 'A', name: 'regular1', kills: 20, deaths: 1 }),
			player('weak', { team: 'A', kills: 0, deaths: 10 }),
		]
		players[2].facts = { ...players[2].facts, tag: 'TT' }
		const manualSwaps = new Map<SM.PlayerId, MH.NormedTeamId>([['b0', 'A']])
		// 4v1 after the swap: one goes to B, and the regular outranks the weaker player
		const result = compute({ settings, players, manualSwaps })
		expect([...result.swaps.keys()]).toEqual(['regular'])
	})

	it('does not re-pick skipped or pending players', () => {
		const players = [...filler('B', 2, 'b'), player('first', { team: 'A' }), player('second', { team: 'A', kills: 1, deaths: 1 })]
		const manualSwaps = new Map<SM.PlayerId, MH.NormedTeamId>([['b0', 'A']])
		expect([...compute({ players, manualSwaps }).swaps.keys()]).toEqual(['first'])
		expect([...compute({ players, manualSwaps, skipped: new Set(['first']) }).swaps.keys()]).toEqual(['second'])
		expect(compute({ players, manualSwaps, skipped: new Set(['first']), pending: new Set(['second']) }).shortfall).toBe(1)
	})
})
