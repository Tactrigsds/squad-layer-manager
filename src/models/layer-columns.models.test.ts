import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import * as LC from '@/models/layer-columns.models'
import type * as L from '@/models/layer.models'

import * as Paths from '../../paths.ts'

function entry(over: Partial<L.LayerFactionAvailabilityEntry> = {}): L.LayerFactionAvailabilityEntry {
	return {
		Faction: 'USA',
		Unit: 'CombinedArms',
		allowedTeams: [1, 2],
		isDefaultUnit: false,
		variants: { boats: false, noHeli: false },
		...over,
	}
}

describe('layer faction availability pooling', () => {
	it('round-trips to the same value it was given', () => {
		const byLayer = {
			Sumari_RAAS_v1: [entry(), entry({ Faction: 'RGF' })],
			Sumari_RAAS_v2: [entry(), entry({ Faction: 'RGF' })],
			Narva_Invasion_v1: [entry({ Unit: 'Armored', allowedTeams: [1], isDefaultUnit: true })],
			Gorodok_Training: [entry({ variants: undefined })],
		}
		expect(LC.expandLayerFactionAvailability(LC.poolLayerFactionAvailability(byLayer))).toEqual(byLayer)
	})

	it('pools identical entries and identical lists', () => {
		const pooled = LC.poolLayerFactionAvailability({
			a: [entry(), entry({ Faction: 'RGF' })],
			b: [entry(), entry({ Faction: 'RGF' })],
			c: [entry()],
		})
		expect(pooled.entries).toHaveLength(2)
		expect(pooled.lists).toHaveLength(2)
		expect(pooled.byLayer.a).toBe(pooled.byLayer.b)
	})

	// entries and lists are shared between layers, which is the whole point, so they are frozen rather than left
	// mutable for a caller to discover the sharing through
	it('shares and freezes what it expands', () => {
		const expanded = LC.expandLayerFactionAvailability(LC.poolLayerFactionAvailability({ a: [entry()], b: [entry()] }))
		expect(expanded.a).toBe(expanded.b)
		expect(Object.isFrozen(expanded.a[0])).toBe(true)
		expect(Object.isFrozen(expanded.a[0].allowedTeams)).toBe(true)
	})

	// artifacts written before the pool existed carry the expanded form, and a deployment can mount one
	it('passes an already-expanded artifact through untouched', () => {
		const byLayer = { a: [entry()] }
		expect(LC.expandLayerFactionAvailability(byLayer)).toBe(byLayer)
	})

	// preprocess builds a scratch components object out of {} to reach the derived abbreviation maps, before it has
	// any availability to put in one
	it('tolerates availability being absent entirely', () => {
		expect(LC.expandLayerFactionAvailability(undefined)).toEqual({})
	})

	it('distinguishes entries that differ only in their variants', () => {
		const pooled = LC.poolLayerFactionAvailability({
			a: [entry({ variants: { boats: true, noHeli: false } })],
			b: [entry({ variants: { boats: false, noHeli: true } })],
			c: [entry({ variants: undefined })],
		})
		expect(pooled.entries).toHaveLength(3)
	})
})

describe('dense id headroom', () => {
	const dir = path.join(Paths.ASSETS, 'layers')
	const versions = fs.readdirSync(dir).filter((name) => /^layer-data_v.+\.json$/.test(name))

	// layer data updates grow the layer count, and ids must stay below 2^30 to stay inline
	it.each(versions)('%s leaves room for twice as many layers', (name) => {
		const file = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as L.LayerDataFile
		const components = LC.buildFullLayerComponents(file.components)
		const doubledLayerBits = 32 - Math.clz32(2 * components.layers.length - 1)
		expect(LC.denseIdLayout(components).localBits + doubledLayerBits).toBeLessThanOrEqual(LC.MAX_DENSE_ID_BITS)
	})
})
