import { describe, expect, it } from 'vitest'

import * as Activity from '@/models/player-activity.models'
import type * as SE from '@/models/server-events.models'
import type * as SM from '@/models/squad.models'

const MIN = 60_000

function player(eos: string, opts: Partial<SM.Player> = {}): SM.Player {
	return { ids: { eos, username: eos }, teamId: 1, squadId: null, isLeader: false, isAdmin: false, role: '', ...opts } as SM.Player
}

const ev = (event: Partial<SE.Event> & { type: SE.Event['type'] }, time: number) => ({ ...event, time }) as SE.Event

describe('player activity', () => {
	it('counts a player active when first seen, and drops them when they leave', () => {
		const t = Activity.init()
		Activity.note(t, ev({ type: 'RESET', state: { players: [player('a')], squads: [] } } as never, 0))
		Activity.note(t, ev({ type: 'PLAYER_CONNECTED', player: player('b') } as never, MIN))
		expect([...t.lastActive]).toEqual([
			['a', 0],
			['b', MIN],
		])
		Activity.note(t, ev({ type: 'PLAYER_DISCONNECTED', player: 'a' } as never, 2 * MIN))
		expect(t.lastActive.has('a')).toBe(false)
	})

	it('moves the clock on what a player does, and not on what is done to them', () => {
		const t = Activity.init()
		Activity.note(t, ev({ type: 'RESET', state: { players: [player('a'), player('b')], squads: [] } } as never, 0))
		Activity.note(t, ev({ type: 'CHAT_MESSAGE', player: 'a' } as never, MIN))
		Activity.note(t, ev({ type: 'PLAYER_CHANGED_TEAM', player: 'b', source: { type: 'slm-user' } } as never, MIN))
		Activity.note(t, ev({ type: 'SQUAD_CREATED', squad: { creator: 'b' }, synthesized: true } as never, MIN))
		expect(t.lastActive.get('a')).toBe(MIN)
		expect(t.lastActive.get('b')).toBe(0)
		Activity.note(t, ev({ type: 'PLAYER_DIED', victim: 'b', attacker: 'a' } as never, 2 * MIN))
		expect(t.lastActive.get('b')).toBe(2 * MIN)
	})

	it('starts every clock again at a new game', () => {
		const t = Activity.init()
		Activity.note(t, ev({ type: 'RESET', state: { players: [player('a')], squads: [] } } as never, 0))
		Activity.note(t, ev({ type: 'NEW_GAME' } as never, 20 * MIN))
		Activity.note(t, ev({ type: 'RESET', state: { players: [player('a')], squads: [] } } as never, 21 * MIN))
		expect(t.lastActive.get('a')).toBe(21 * MIN)
	})

	it('never counts a player in a squad or in a vehicle as idle', () => {
		expect(Activity.isIdle(player('a'), 0, 30 * MIN, 10 * MIN)).toBe(true)
		expect(Activity.isIdle(player('a', { squadId: 1 }), 0, 30 * MIN, 10 * MIN)).toBe(false)
		expect(Activity.isIdle(player('a', { vehicle: 'BTR80 (Driver)' }), 0, 30 * MIN, 10 * MIN)).toBe(false)
		expect(Activity.isIdle(player('a'), 25 * MIN, 30 * MIN, 10 * MIN)).toBe(false)
	})
})
