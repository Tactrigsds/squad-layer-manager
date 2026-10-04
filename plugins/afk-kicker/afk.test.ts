import { describe, expect, it } from 'vitest'

import type * as SE from 'slm/models/server-events'
import type * as SM from 'slm/models/squad'

import * as Afk from './afk.ts'

const MIN = 60_000
const SQUADLESS: Afk.Rule = { kind: 'squadless', window: 5 * MIN }
const IDLE: Afk.Rule = { kind: 'idle', window: 15 * MIN }

function player(id: string, squadId: number | null): SM.Player {
	return { ids: { eos: id, username: id }, teamId: 1, squadId, isLeader: false, isAdmin: false, role: '' } as SM.Player
}

function roster(...players: SM.Player[]): Map<SM.PlayerId, SM.Player> {
	return new Map(players.map((p) => [p.ids.eos, p]))
}

describe('kicksNeeded', () => {
	const full = { maxPlayerCount: 100, playerCount: 100 }

	it('kicks one per queued player on a full server', () => {
		expect(Afk.kicksNeeded({ ...full, queueLength: 3 }, 0, 0)).toBe(3)
	})

	it('holds a positive target in the queue', () => {
		expect(Afk.kicksNeeded({ ...full, queueLength: 3 }, 2, 0)).toBe(1)
	})

	it('keeps slots open for a negative target, even with nobody waiting', () => {
		expect(Afk.kicksNeeded({ ...full, queueLength: 0 }, -2, 0)).toBe(2)
		expect(Afk.kicksNeeded({ maxPlayerCount: 100, playerCount: 98, queueLength: 0 }, -2, 0)).toBe(0)
	})

	it('does not count reserved slots as room for the public queue', () => {
		expect(Afk.kicksNeeded({ maxPlayerCount: 100, playerCount: 98, reserveSlots: 2, queueLength: 1 }, 0, 0)).toBe(1)
	})

	it('counts recent kicks as slots already freed', () => {
		expect(Afk.kicksNeeded({ ...full, queueLength: 3 }, 0, 3)).toBe(0)
	})

	it('refuses numbers that cannot be right', () => {
		expect(Afk.kicksNeeded({ maxPlayerCount: 0, playerCount: 40, queueLength: 1 }, 0, 0)).toBeNull()
		expect(Afk.kicksNeeded({ maxPlayerCount: 100, playerCount: 101, queueLength: 1 }, 0, 0)).toBeNull()
	})
})

describe('afkPlayers', () => {
	it('takes the idle rule from SLM, skipping unkickable players', () => {
		const t = Afk.init()
		const r = roster(player('a', 1), player('b', null))
		t.unkickable.add('b')
		const idle = [
			{ id: 'a', player: player('a', 1), lastActive: 2 * MIN },
			{ id: 'b', player: player('b', null), lastActive: 0 },
		]
		expect(Afk.afkPlayers(t, r, IDLE, 20 * MIN, idle)).toEqual([{ id: 'a', player: idle[0].player, since: 2 * MIN, reason: 'idle' }])
	})

	it('judges only by squad on a squad gamemode', () => {
		const t = Afk.init()
		const r = roster(player('squadded', 1), player('squadless', null))
		Afk.observe(t, r, 0)
		expect(Afk.afkPlayers(t, r, SQUADLESS, 60 * MIN, []).map((a) => a.id)).toEqual(['squadless'])
	})

	it('restarts the squadless clock at a new game', () => {
		const t = Afk.init()
		const r = roster(player('a', null))
		Afk.observe(t, r, 0)
		Afk.note(t, { type: 'NEW_GAME' } as SE.Event)
		Afk.observe(t, r, 14 * MIN)
		expect(Afk.afkPlayers(t, r, SQUADLESS, 18 * MIN, [])).toEqual([])
		expect(Afk.afkPlayers(t, r, SQUADLESS, 19 * MIN, []).map((a) => a.reason)).toEqual(['squadless'])
	})

	it('orders longest AFK first', () => {
		const t = Afk.init()
		Afk.observe(t, roster(player('early', null)), 0)
		const r = roster(player('late', null), player('early', null))
		Afk.observe(t, r, 2 * MIN)
		expect(Afk.afkPlayers(t, r, SQUADLESS, 10 * MIN, []).map((a) => a.id)).toEqual(['early', 'late'])
	})

	it('skips an unkickable player across games until they leave', () => {
		const t = Afk.init()
		const r = roster(player('dev', null), player('a', null))
		Afk.observe(t, r, 0)
		t.unkickable.add('dev')
		Afk.note(t, { type: 'NEW_GAME' } as SE.Event)
		Afk.observe(t, r, MIN)
		expect(Afk.afkPlayers(t, r, SQUADLESS, 10 * MIN, []).map((a) => a.id)).toEqual(['a'])
		Afk.observe(t, roster(player('a', null)), 10 * MIN)
		Afk.observe(t, r, 10 * MIN)
		expect(Afk.afkPlayers(t, r, SQUADLESS, 20 * MIN, []).map((a) => a.id)).toEqual(['a', 'dev'])
	})
})
