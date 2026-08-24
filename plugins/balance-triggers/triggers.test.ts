import { describe, expect, it } from 'vitest'

import type * as MH from 'slm/models/match-history'

import * as TR from './triggers.ts'

const RAAS = 'GD-RAAS-V1:USA-CA:RGF-CA'
const SEED = 'SM-SD-V1:RGF-CA:VDV-CA'

let nextId = 1
// winner null = in-progress. Consecutive ordinals swap the team1/team2 <-> A/B mapping, so "the same
// side keeps winning" is alternating raw winners.
function match(ordinal: number, winner: 1 | 2 | null, opts?: { layerId?: string; margin?: number }): MH.MatchDetails {
	const base = {
		layerSource: { type: 'unknown' as const },
		ordinal,
		layerId: opts?.layerId ?? RAAS,
		historyEntryId: nextId++,
		serverId: 's',
		isCurrentMatch: false,
		createdAt: null,
	}
	if (winner === null) return { ...base, status: 'in-progress' }
	const margin = opts?.margin ?? 300
	return {
		...base,
		status: 'post-game',
		endTime: new Date(0),
		outcome: { type: winner === 1 ? 'team1' : 'team2', team1Tickets: winner === 1 ? margin : 0, team2Tickets: winner === 2 ? margin : 0 },
	}
}

function fire(id: string, history: MH.MatchDetails[]) {
	return TR.TRIGGERS.find((t) => t.id === id)!.evaluate({ history })
}

describe('150x2', () => {
	it('fires when the same normed side wins twice by 150+', () => {
		const res = fire('150x2', [match(0, 1), match(1, 2)])
		expect(res).toMatchObject({ strongerTeam: 'teamA' })
	})

	it('does not fire when the sides trade wins', () => {
		expect(fire('150x2', [match(0, 1), match(1, 1)])).toBeUndefined()
	})

	it('does not fire below the margin', () => {
		expect(fire('150x2', [match(0, 1), match(1, 2, { margin: 100 })])).toBeUndefined()
	})

	it('skips the still-in-progress match after the one just finalized', () => {
		expect(fire('150x2', [match(0, 1), match(1, 2), match(2, null)])).toMatchObject({ strongerTeam: 'teamA' })
	})

	it('a match with no recorded outcome ends the session instead of being skipped over', () => {
		expect(fire('150x2', [match(0, 1), match(1, null), match(2, 1)])).toBeUndefined()
	})

	it('a session-breaking gamemode between the wins resets the streak', () => {
		expect(fire('150x2', [match(0, 1), match(1, 2, { layerId: SEED }), match(2, 1)])).toBeUndefined()
	})
})

describe('RWS5', () => {
	it('fires on five straight wins regardless of margin', () => {
		const history = [0, 1, 2, 3, 4].map((ordinal) => match(ordinal, ordinal % 2 === 0 ? 1 : 2, { margin: 10 }))
		expect(fire('RWS5', history)).toMatchObject({ strongerTeam: 'teamA' })
		expect(fire('150x2', history)).toBeUndefined()
	})
})
