import { describe, expect, it } from 'vitest'

import { eosIdForName, makePlayer, steamIdForName } from './world.ts'

describe('player ids', () => {
	it('are the same for a name every time, so anything written about a player before they connect still finds them', () => {
		expect(steamIdForName('Player1')).toBe(steamIdForName('Player1'))
		expect(eosIdForName('Player1')).toBe(eosIdForName('Player1'))
		expect(makePlayer({ name: 'Player1' }).steam).toBe(steamIdForName('Player1'))
	})

	it('differ between names', () => {
		const names = ['Player1', 'Player2', 'Player10', 'Alice', 'Bob']
		expect(new Set(names.map((n) => steamIdForName(n))).size).toBe(names.length)
		expect(new Set(names.map((n) => eosIdForName(n))).size).toBe(names.length)
	})

	// the shapes Admins.cfg and the log parser match on
	it('look like the real thing', () => {
		for (const name of ['Player1', 'Player24', 'Alice', '[TAG]Bob']) {
			expect(steamIdForName(name), name).toMatch(/^\d{17}$/)
			expect(eosIdForName(name), name).toMatch(/^0002[a-f0-9]{28}$/)
		}
	})

	it('takes an explicit id over the derived one', () => {
		const player = makePlayer({ name: 'Player1', steam: '76561190000000001' })
		expect(player.steam).toBe('76561190000000001')
	})

	// concurrent sandbox instances (tutorials) both connect the same fabricated names; the salt keeps their ids apart
	// so they don't collide on the shared players table, while staying stable within one instance
	it('are disambiguated by a salt across instances, stable within one', () => {
		expect(steamIdForName('Player1', 'srv-a')).not.toBe(steamIdForName('Player1', 'srv-b'))
		expect(eosIdForName('Player1', 'srv-a')).not.toBe(eosIdForName('Player1', 'srv-b'))
		expect(steamIdForName('Player1', 'srv-a')).toBe(steamIdForName('Player1', 'srv-a'))
		// an unsalted id is the legacy derivation, distinct from any salted one
		expect(steamIdForName('Player1')).not.toBe(steamIdForName('Player1', 'srv-a'))
		// salted ids keep the real shapes
		expect(steamIdForName('Player1', 'srv-a')).toMatch(/^\d{17}$/)
		expect(eosIdForName('Player1', 'srv-a')).toMatch(/^0002[a-f0-9]{28}$/)
	})
})
