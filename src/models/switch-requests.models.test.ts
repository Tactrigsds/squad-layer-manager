import { describe, expect, it } from 'vitest'

import type * as SM from '@/models/squad.models'
import * as SRQ from '@/models/switch-requests.models'

let requestCounter = 0
function request(playerId: SM.PlayerId, fromTeam: SM.TeamId): SRQ.SwitchRequest {
	return { playerId, fromTeam, requestedAt: requestCounter++ }
}

// a roster with `team1` players on team 1 and `team2` on team 2, named t1-0..n / t2-0..n, with `named` players
// (already counted in those sizes) pinned to specific ids so requests can reference them
function roster(team1: number, team2: number, named: [SM.PlayerId, SM.TeamId | null][] = []): SRQ.Roster {
	const out: SRQ.Roster = new Map(named)
	let placed1 = [...out.values()].filter((t) => t === 1).length
	let placed2 = [...out.values()].filter((t) => t === 2).length
	for (let i = 0; placed1 < team1; i++, placed1++) out.set(`t1-${i}`, 1)
	for (let i = 0; placed2 < team2; i++, placed2++) out.set(`t2-${i}`, 2)
	return out
}

function plan(input: Partial<SRQ.PlanInput> & Pick<SRQ.PlanInput, 'requests' | 'roster'>): SRQ.Plan {
	return SRQ.plan({ instantSwapLead: 1, swapping: new Set(), ...input })
}

describe('prune', () => {
	it('drops a request whose player left', () => {
		const p = plan({ requests: [request('gone', 1)], roster: roster(2, 2) })
		expect(p.removed).toEqual([{ playerId: 'gone', reason: 'disconnected' }])
		expect(p.requests).toEqual([])
	})

	it('drops a request whose player is already on the other team', () => {
		const p = plan({ requests: [request('a', 1)], roster: roster(2, 2, [['a', 2]]) })
		expect(p.removed).toEqual([{ playerId: 'a', reason: 'fulfilled-externally' }])
		expect(p.swaps).toEqual([])
	})

	it('keeps a team-less player queued but does not swap them', () => {
		const p = plan({ requests: [request('a', 1)], roster: roster(3, 1, [['a', null]]) })
		expect(p.removed).toEqual([])
		expect(p.requests.map((r) => r.playerId)).toEqual(['a'])
		expect(p.swaps).toEqual([])
	})
})

describe('capacity', () => {
	it('swaps the head when the sender team leads by the configured margin', () => {
		const p = plan({ requests: [request('a', 1)], roster: roster(3, 2, [['a', 1]]) })
		expect(p.swaps).toEqual([{ playerId: 'a', fromTeam: 1, toTeam: 2, via: 'capacity' }])
		expect(p.fulfilled).toEqual(['a'])
		expect(p.requests).toEqual([])
	})

	it('queues when the teams are even', () => {
		const p = plan({ requests: [request('a', 1)], roster: roster(3, 3, [['a', 1]]) })
		expect(p.swaps).toEqual([])
		expect(p.requests.map((r) => r.playerId)).toEqual(['a'])
	})

	it('respects a higher instantSwapLead', () => {
		const p = plan({ requests: [request('a', 1)], roster: roster(4, 3, [['a', 1]]), instantSwapLead: 2 })
		expect(p.swaps).toEqual([])
	})

	it('lead 0 lets even teams switch', () => {
		const p = plan({ requests: [request('a', 1)], roster: roster(3, 3, [['a', 1]]), instantSwapLead: 0 })
		expect(p.swaps.map((s) => s.playerId)).toEqual(['a'])
	})

	it('drains several waiters while the lead holds, in FIFO order', () => {
		const requests = [request('a', 1), request('b', 1), request('c', 1)]
		const p = plan({
			requests,
			roster: roster(6, 2, [
				['a', 1],
				['b', 1],
				['c', 1],
			]),
		})
		// 6v2: a swaps (5v3), b swaps (4v4), c stays
		expect(p.swaps.map((s) => s.playerId)).toEqual(['a', 'b'])
		expect(p.requests.map((r) => r.playerId)).toEqual(['c'])
	})

	it('skips an in-flight head and takes the next waiter', () => {
		const requests = [request('a', 1), request('b', 1)]
		const p = plan({
			requests,
			roster: roster(4, 2, [
				['a', 1],
				['b', 1],
			]),
			swapping: new Set(['a']),
		})
		expect(p.swaps.map((s) => s.playerId)).toEqual(['b'])
		expect(p.requests.map((r) => r.playerId)).toEqual(['a'])
	})
})

describe('mutual', () => {
	it('pairs waiters from both sides even when teams are even', () => {
		const requests = [request('a', 1), request('b', 2)]
		const p = plan({
			requests,
			roster: roster(3, 3, [
				['a', 1],
				['b', 2],
			]),
		})
		expect(p.swaps).toEqual([
			{ playerId: 'a', fromTeam: 1, toTeam: 2, via: 'mutual' },
			{ playerId: 'b', fromTeam: 2, toTeam: 1, via: 'mutual' },
		])
		expect(p.requests).toEqual([])
	})

	it('drains pairs until one side runs dry', () => {
		const requests = [request('a', 1), request('b', 1), request('c', 2)]
		const p = plan({
			requests,
			roster: roster(4, 4, [
				['a', 1],
				['b', 1],
				['c', 2],
			]),
		})
		expect(p.fulfilled.sort()).toEqual(['a', 'c'])
		expect(p.requests.map((r) => r.playerId)).toEqual(['b'])
	})
})

describe('connector', () => {
	it('moves a fresh connect off the target team and fulfills the head', () => {
		// even before the connect; the connector landed on team 2, where a is trying to go
		const p = plan({
			requests: [request('a', 1)],
			roster: roster(3, 4, [
				['a', 1],
				['fresh', 2],
			]),
			connector: { playerId: 'fresh', teamId: 2 },
		})
		expect(p.swaps).toEqual([
			{ playerId: 'fresh', fromTeam: 2, toTeam: 1, via: 'connector' },
			{ playerId: 'a', fromTeam: 1, toTeam: 2, via: 'connector' },
		])
		expect(p.fulfilled).toEqual(['a'])
	})

	it('ignores the connector when nobody is waiting for their team', () => {
		const p = plan({
			requests: [request('a', 2)],
			roster: roster(3, 4, [
				['a', 2],
				['fresh', 2],
			]),
			connector: { playerId: 'fresh', teamId: 2 },
		})
		// a (on team 2) drains via capacity instead: 4v3 meets the lead
		expect(p.swaps).toEqual([{ playerId: 'a', fromTeam: 2, toTeam: 1, via: 'capacity' }])
	})

	it('never moves a connector who is themselves queued', () => {
		const p = plan({
			requests: [request('fresh', 2), request('a', 1)],
			roster: roster(3, 3, [
				['a', 1],
				['fresh', 2],
			]),
			connector: { playerId: 'fresh', teamId: 2 },
		})
		// they pair up as a mutual swap instead
		expect(p.swaps.every((s) => s.via === 'mutual')).toBe(true)
	})
})

describe('positions', () => {
	it('numbers each direction independently', () => {
		const requests = [request('a', 1), request('b', 2), request('c', 1)]
		expect(SRQ.position(requests, 'a')).toBe(1)
		expect(SRQ.position(requests, 'b')).toBe(1)
		expect(SRQ.position(requests, 'c')).toBe(2)
		expect(SRQ.position(requests, 'missing')).toBeNull()
	})
})
