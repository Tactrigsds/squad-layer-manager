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
		expect(new Set(names.map(steamIdForName)).size).toBe(names.length)
		expect(new Set(names.map(eosIdForName)).size).toBe(names.length)
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
})
