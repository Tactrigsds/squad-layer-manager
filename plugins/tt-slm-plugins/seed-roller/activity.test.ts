import { describe, expect, it } from 'vitest'

import type * as SE from 'slm/models/server-events'
import type * as SM from 'slm/models/squad'

import * as Activity from './activity.ts'

const player = (eos: string) => ({ ids: { eos, username: eos } }) as SM.Player
const roster = (...eos: string[]) => eos.map(player)

// only the fields the tracker reads; the rest of an event is irrelevant to it
const event = (e: Record<string, unknown> & { type: string }) => e as unknown as SE.Event

const WINDOW = 60_000
const T0 = 1_000_000

describe('activity', () => {
	it('counts a player active only inside the window', () => {
		const activity = Activity.init()
		Activity.note(activity, event({ type: 'CHAT_MESSAGE', player: 'a' }), T0)
		expect(Activity.census(activity, roster('a'), T0 + WINDOW, WINDOW)).toMatchObject({ activePopulation: 1, afkPopulation: 0 })
		expect(Activity.census(activity, roster('a'), T0 + WINDOW + 1, WINDOW)).toMatchObject({ activePopulation: 0, afkPopulation: 1 })
	})

	it('treats a player nothing is known about as afk', () => {
		expect(Activity.census(Activity.init(), roster('a', 'b'), T0, WINDOW)).toEqual({
			population: 2,
			activePopulation: 0,
			afkPopulation: 2,
		})
	})

	it('starts the clock when a player connects, so a fresh joiner is never afk', () => {
		const activity = Activity.init()
		Activity.note(activity, event({ type: 'PLAYER_CONNECTED', player: player('a') }), T0)
		expect(Activity.census(activity, roster('a'), T0, WINDOW)).toMatchObject({ activePopulation: 1 })
	})

	it('credits the attacker of a kill and not the victim', () => {
		const activity = Activity.init()
		Activity.note(activity, event({ type: 'PLAYER_DIED', attacker: 'a', victim: 'b', variant: 'normal' }), T0)
		expect(Activity.census(activity, roster('a', 'b'), T0, WINDOW)).toMatchObject({ activePopulation: 1, afkPopulation: 1 })
	})

	it('credits nobody for a suicide', () => {
		const activity = Activity.init()
		Activity.note(activity, event({ type: 'PLAYER_DIED', attacker: 'a', victim: 'a', variant: 'suicide' }), T0)
		expect(Activity.census(activity, roster('a'), T0, WINDOW)).toMatchObject({ activePopulation: 0 })
	})

	// the distinction the whole tracker turns on: SLM's own polling and admin actions are not the player
	// doing something, and counting them would make an idle server look busy
	it('ignores polling and admin-sourced events', () => {
		const activity = Activity.init()
		Activity.note(activity, event({ type: 'PLAYER_RECONCILED', player: player('a') }), T0)
		Activity.note(activity, event({ type: 'TEAMS_POLLED_UPDATE' }), T0)
		Activity.note(activity, event({ type: 'PLAYER_CHANGED_TEAM', player: 'a', source: { type: 'rcon' } }), T0)
		Activity.note(activity, event({ type: 'SQUAD_CREATED', squad: { creator: 'a' }, synthesized: true }), T0)
		expect(Activity.census(activity, roster('a'), T0, WINDOW)).toMatchObject({ activePopulation: 0 })
	})

	it('counts an organic team change but not a forced one', () => {
		const activity = Activity.init()
		Activity.note(activity, event({ type: 'PLAYER_CHANGED_TEAM', player: 'a' }), T0)
		expect(Activity.census(activity, roster('a'), T0, WINDOW)).toMatchObject({ activePopulation: 1 })
	})

	it('counts the roster, not the stamps: someone who left stops counting', () => {
		const activity = Activity.init()
		Activity.note(activity, event({ type: 'CHAT_MESSAGE', player: 'a' }), T0)
		Activity.note(activity, event({ type: 'CHAT_MESSAGE', player: 'b' }), T0)
		expect(Activity.census(activity, roster('a'), T0, WINDOW)).toEqual({ population: 1, activePopulation: 1, afkPopulation: 0 })
	})

	it('prunes stamps for players no longer present', () => {
		const activity = Activity.init()
		Activity.note(activity, event({ type: 'CHAT_MESSAGE', player: 'a' }), T0)
		Activity.note(activity, event({ type: 'CHAT_MESSAGE', player: 'gone' }), T0)
		Activity.prune(activity, roster('a'))
		expect([...activity.lastActive.keys()]).toEqual(['a'])
	})
})
