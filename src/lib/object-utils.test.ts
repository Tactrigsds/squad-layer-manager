import { describe, expect, it } from 'vitest'

import * as Obj from './object-utils'

describe('internStrings', () => {
	// Whether two equal strings start out as one instance is V8's business (it internalizes literals on its
	// own), so what is asserted here is the contract: equal strings come out as one instance, and nothing
	// about the data changes.
	it('collapses equal strings onto one instance, leaving the values alone', () => {
		const parsed = JSON.parse('{"one":{"Faction":"USA"},"two":{"Faction":"USA"},"three":{"Faction":"RGF"}}')

		const value = Obj.internStrings(parsed)

		expect(value.one.Faction).toBe(value.two.Faction)
		expect(value).toEqual({ one: { Faction: 'USA' }, two: { Faction: 'USA' }, three: { Faction: 'RGF' } })
	})

	// The layer availability pool shares one frozen entry between every layer that uses it
	// (expandLayerFactionAvailability). Interning walked in place, so it threw on the first shared entry it
	// reached, which took down every boot of the app and every test with it.
	it('leaves frozen structures alone rather than writing into them', () => {
		const shared = Object.freeze({ Faction: JSON.parse('"USA"') as string })
		const lists = Object.freeze([shared])

		const value = Obj.internStrings({ Faction: 'USA', pooled: { lists }, alsoPooled: { lists } })

		expect(value.pooled.lists[0]).toBe(shared)
		expect(value.pooled.lists[0].Faction).toBe('USA')
	})
})
