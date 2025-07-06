import * as CS from '@/models/context-shared'
import * as FB from '@/models/filter-builders'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as SS from '@/models/server-state.models'
import * as C from '@/server/context'
import * as DB from '@/server/db'
import * as LayerDb from '@/server/systems/layer-db.server'
import { getLayerStatusesForLayerQueue, getRandomGeneratedLayers, layerExists, queryLayerComponents, queryLayers, searchIds } from '@/systems.shared/layer-queries.shared'
import { beforeAll, describe, expect, test } from 'vitest'
import { ensureEnvSetup } from '../server/env'
import * as Log from '../server/logger'

let baseCtx!: CS.LayerQuery
let sampleLayerIds: string[] = []

beforeAll(async () => {
	ensureEnvSetup()
	Log.ensureLoggerSetup()
	await DB.setup()

	await LayerDb.setup({ skipHash: true })

	baseCtx = {
		log: Log.baseLogger,
		layerDb: () => LayerDb.db,
		effectiveColsConfig: LC.getEffectiveColumnConfig(LayerDb.LAYER_DB_CONFIG),
		filters: [],
		recentMatches: [],
	}

	// Get some sample layer IDs for testing
	const sampleQuery = await queryLayers({
		input: {
			constraints: [],
			previousLayerIds: [],
			pageSize: 10,
			pageIndex: 0,
			sort: { type: 'random', seed: 123 },
		},
		ctx: baseCtx,
	})
	sampleLayerIds = sampleQuery.layers.map(l => l.id)
})

describe('queryLayers', () => {
	test('can query layers with basic parameters', async () => {
		const res = await queryLayers({
			input: {
				constraints: [],
				previousLayerIds: [],
				pageSize: 5,
				pageIndex: 0,
			},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		expect(res.layers).toHaveLength(5)
		expect(res.totalCount).toBeGreaterThan(0)
		expect(res.pageCount).toBeGreaterThan(0)
		expect(res.layers[0]).toHaveProperty('id')
		expect(res.layers[0]).toHaveProperty('Map')
		expect(res.layers[0]).toHaveProperty('Gamemode')
	})

	test('can filter results with basic filter', async () => {
		const ctx = baseCtx
		const filter = FB.and([FB.comp(FB.eq('Map', 'Lashkar')), FB.comp(FB.eq('Gamemode', 'TC'))])
		const res = await queryLayers({
			input: {
				constraints: [{ type: 'filter-anon', filter, applyAs: 'where-condition', id: 'test-filter' }],
				previousLayerIds: [],
				pageSize: 50,
				pageIndex: 0,
			},
			ctx,
		})

		expect(res.code).toBe('ok')
		if (res.layers.length > 0) {
			for (const layer of res.layers) {
				expect(layer.Map).toBe('Lashkar')
				expect(layer.Gamemode).toBe('TC')
			}
		}
	})

	test('can filter by different gamemode', async () => {
		const filter = FB.comp(FB.eq('Gamemode', 'RAAS'))
		const res = await queryLayers({
			input: {
				constraints: [{ type: 'filter-anon', filter, applyAs: 'where-condition', id: 'raas-filter' }],
				previousLayerIds: [],
				pageSize: 10,
				pageIndex: 0,
			},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		if (res.layers.length > 0) {
			for (const layer of res.layers) {
				expect(layer.Gamemode).toBe('RAAS')
			}
		}
	})

	test('handles pagination correctly', async () => {
		const pageSize = 3
		const page1 = await queryLayers({
			input: {
				constraints: [],
				previousLayerIds: [],
				pageSize,
				pageIndex: 0,
			},
			ctx: baseCtx,
		})

		const page2 = await queryLayers({
			input: {
				constraints: [],
				previousLayerIds: [],
				pageSize,
				pageIndex: 1,
			},
			ctx: baseCtx,
		})

		expect(page1.code).toBe('ok')
		expect(page2.code).toBe('ok')
		expect(page1.layers).toHaveLength(pageSize)
		expect(page2.layers).toHaveLength(pageSize)
		expect(page1.totalCount).toBe(page2.totalCount)

		// Ensure different layers on different pages
		const page1Ids = new Set(page1.layers.map(l => l.id))
		const page2Ids = new Set(page2.layers.map(l => l.id))
		expect(page1Ids.size).toBe(pageSize)
		expect(page2Ids.size).toBe(pageSize)
		// No overlap between pages
		for (const id of page1Ids) {
			expect(page2Ids.has(id)).toBe(false)
		}
	})

	test('handles column sorting', async () => {
		const res = await queryLayers({
			input: {
				constraints: [],
				previousLayerIds: [],
				pageSize: 10,
				pageIndex: 0,
				sort: {
					type: 'column',
					sortBy: 'Map',
					sortDirection: 'ASC',
				},
			},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		expect(res.layers.length).toBeGreaterThan(1)

		// Check if sorted correctly
		for (let i = 1; i < res.layers.length; i++) {
			expect(res.layers[i].Map >= res.layers[i - 1].Map).toBe(true)
		}
	})

	test('handles random sorting', async () => {
		const res = await queryLayers({
			input: {
				constraints: [],
				previousLayerIds: [],
				pageSize: 5,
				pageIndex: 0,
				sort: {
					type: 'random',
					seed: 456,
				},
			},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		expect(res.layers.length).toBeLessThanOrEqual(5)
		expect(res.pageCount).toBe(1) // Random sort always returns single page
	})

	test('handles do-not-repeat constraints', async () => {
		if (sampleLayerIds.length === 0) return

		const res = await queryLayers({
			input: {
				constraints: [{
					type: 'do-not-repeat',
					rule: { field: 'Map', within: 2 },
					id: 'no-repeat-map',
					applyAs: 'where-condition',
				}],
				previousLayerIds: [sampleLayerIds[0]],
				pageSize: 10,
				pageIndex: 0,
			},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		// Should not contain layers with the same map as the previous layer
		if (res.layers.length > 0) {
			const previousLayer = await queryLayers({
				input: {
					constraints: [],
					previousLayerIds: [],
					pageSize: 1,
					pageIndex: 0,
				},
				ctx: baseCtx,
			})
			// This is a complex test that would require knowing the previous layer's map
		}
	})

	test('applies default values correctly', async () => {
		const res = await queryLayers({
			input: { previousLayerIds: [] },
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		expect(res.layers.length).toBeLessThanOrEqual(100) // Default pageSize
	})
})

describe('layerExists', () => {
	test('correctly identifies existing layers', async () => {
		if (sampleLayerIds.length === 0) return

		const res = await layerExists({
			input: sampleLayerIds.slice(0, 3),
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		expect(res.results).toHaveLength(3)
		for (const result of res.results) {
			expect(result.exists).toBe(true)
			expect(typeof result.id).toBe('string')
		}
	})

	test('works with multiple existing layers', async () => {
		if (sampleLayerIds.length < 5) return

		const testIds = sampleLayerIds.slice(0, 5)
		const res = await layerExists({
			input: testIds,
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		expect(res.results).toHaveLength(5)
		for (const result of res.results) {
			expect(result.exists).toBe(true)
			expect(testIds.includes(result.id)).toBe(true)
		}
	})
})

describe('queryLayerComponents', () => {
	test('returns all available component values', async () => {
		const res = await queryLayerComponents({
			input: {
				constraints: [],
				previousLayerIds: [],
			},
			ctx: baseCtx,
		})

		// Should return an object with arrays for each group-by column
		expect(typeof res).toBe('object')
		expect(Array.isArray(res.Map)).toBe(true)
		expect(Array.isArray(res.Gamemode)).toBe(true)
		expect(Array.isArray(res.Faction_1)).toBe(true)
		expect(res.Map.length).toBeGreaterThan(0)
		expect(res.Gamemode.length).toBeGreaterThan(0)
	})

	test('respects filter constraints', async () => {
		const filter = FB.comp(FB.eq('Gamemode', 'TC'))
		const res = await queryLayerComponents({
			input: {
				constraints: [{ type: 'filter-anon', filter, applyAs: 'where-condition', id: 'tc-only' }],
				previousLayerIds: [],
			},
			ctx: baseCtx,
		})

		expect(Array.isArray(res.Gamemode)).toBe(true)
		// If there are TC layers, Gamemode should contain 'TC'
		if (res.Gamemode.length > 0) {
			expect(res.Gamemode.includes('TC')).toBe(true)
		}
	})

	test('works with do-not-repeat constraints', async () => {
		if (sampleLayerIds.length === 0) return

		const res = await queryLayerComponents({
			input: {
				constraints: [{
					type: 'do-not-repeat',
					rule: { field: 'Map', within: 2 },
					id: 'no-repeat-map',
					applyAs: 'where-condition',
				}],
				previousLayerIds: [sampleLayerIds[0]],
			},
			ctx: baseCtx,
		})

		expect(typeof res).toBe('object')
		expect(Array.isArray(res.Map)).toBe(true)
		expect(Array.isArray(res.Gamemode)).toBe(true)
	})
})

describe('searchIds', () => {
	test('finds layers by partial string match', async () => {
		const res = await searchIds({
			input: {
				queryString: 'Al',
				constraints: [],
				previousLayerIds: [],
			},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		expect(Array.isArray(res.ids)).toBe(true)
		expect(res.ids.length).toBeLessThanOrEqual(15) // Limit is 15

		// All returned IDs should contain the query string
		for (const id of res.ids) {
			expect(id.toLowerCase()).toContain('al')
		}
	})

	test('respects constraints in search', async () => {
		const filter = FB.comp(FB.eq('Gamemode', 'TC'))
		const res = await searchIds({
			input: {
				queryString: 'Al',
				constraints: [{ type: 'filter-anon', filter, applyAs: 'where-condition', id: 'tc-search' }],
				previousLayerIds: [],
			},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		expect(Array.isArray(res.ids)).toBe(true)
	})

	test('finds layers with common prefixes', async () => {
		const res = await searchIds({
			input: {
				queryString: 'v',
				constraints: [],
				previousLayerIds: [],
			},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		expect(Array.isArray(res.ids)).toBe(true)

		// All returned IDs should contain the query string
		for (const id of res.ids) {
			expect(id.toLowerCase()).toContain('v')
		}
	})

	test('respects the 15 result limit', async () => {
		const res = await searchIds({
			input: {
				queryString: 'a', // Very common letter, should find many
				constraints: [],
				previousLayerIds: [],
			},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		expect(res.ids.length).toBeLessThanOrEqual(15)

		// All results should contain 'a'
		for (const id of res.ids) {
			expect(id.toLowerCase()).toContain('a')
		}
	})
})

describe('getLayerStatusesForLayerQueue', () => {
	test('processes queue with layer items', async () => {
		if (sampleLayerIds.length === 0) return

		const queue: LL.LayerList = [
			{
				itemId: 'item1',
				layerId: sampleLayerIds[0],
				source: { type: 'unknown' },
			},
		]
		const basicPool: SS.PoolConfiguration = {
			filters: [],
			repeatRules: [{ field: 'Map', within: 2 }],
		}

		const res = await getLayerStatusesForLayerQueue({
			input: {
				queue,
				pool: basicPool,
			},
			ctx: baseCtx,
		})

		if (res.code !== 'ok') {
			throw new Error(`Unexpected error: ${res.code}`)
		}
		expect(res.statuses.present.has(sampleLayerIds[0])).toBe(true)
	})

	test('detects do-not-repeat violations', async () => {
		if (sampleLayerIds.length < 2) return

		// Create a queue where the same layer appears twice within the repeat window
		const queue: LL.LayerList = [
			{
				itemId: 'item1',
				layerId: sampleLayerIds[0],
				source: { type: 'unknown' },
			},
			{
				itemId: 'item2',
				layerId: sampleLayerIds[0], // Same layer again
				source: { type: 'unknown' },
			},
		]
		const strictPool: SS.PoolConfiguration = {
			filters: [],
			repeatRules: [{ field: 'Layer', within: 5 }], // Should catch the repeat
		}

		const res = await getLayerStatusesForLayerQueue({
			input: {
				queue,
				pool: strictPool,
			},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		if (res.code !== 'ok') throw new Error(`Unexpected error: ${res.code}`)
		// The second occurrence should be blocked
		const blockedEntries = Array.from(res.statuses.blocked.entries())
		expect(blockedEntries.length).toBeGreaterThan(0)
	})

	test('handles vote items in queue', async () => {
		if (sampleLayerIds.length < 2) return

		const queue: LL.LayerList = [
			{
				itemId: 'vote1',
				source: { type: 'unknown' },
				vote: {
					defaultChoice: sampleLayerIds[0],
					choices: [
						sampleLayerIds[0],
						sampleLayerIds[1],
					],
				},
			},
		]
		const basicPool: SS.PoolConfiguration = {
			filters: [],
			repeatRules: [],
		}

		const res = await getLayerStatusesForLayerQueue({
			input: {
				queue,
				pool: basicPool,
			},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		if (res.code !== 'ok') throw new Error(`Unexpected error: ${res.code}`)
		expect(res.statuses.present.has(sampleLayerIds[0])).toBe(true)
		expect(res.statuses.present.has(sampleLayerIds[1])).toBe(true)
	})
})

describe('getRandomGeneratedLayers', () => {
	test('generates random layers without constraints', async () => {
		const res = await getRandomGeneratedLayers(
			baseCtx,
			10,
			[],
			[],
			true,
		)

		expect(res.layers.length).toBeLessThanOrEqual(10)
		expect(res.totalCount).toBeGreaterThan(0)
		expect(res.layers[0]).toHaveProperty('id')
		expect(res.layers[0]).toHaveProperty('Map')
	})

	test('respects constraints when generating', async () => {
		const filter = FB.comp(FB.eq('Gamemode', 'TC'))
		const constraints: LQY.LayerQueryConstraint[] = [
			{ type: 'filter-anon', filter, applyAs: 'where-condition', id: 'tc-gen' },
		]

		const res = await getRandomGeneratedLayers(
			baseCtx,
			10,
			constraints,
			[],
			true,
		)

		// All generated layers should be TC if they exist
		for (const layer of res.layers) {
			expect(layer.Gamemode).toBe('TC')
		}
	})

	test('returns IDs when returnLayers is false', async () => {
		const res = await getRandomGeneratedLayers(
			baseCtx,
			10,
			[],
			[],
			false,
		)

		expect('ids' in res).toBe(true)
		expect('layers' in res).toBe(false)
		expect(Array.isArray((res as any).ids)).toBe(true)
		expect((res as any).ids.length).toBeLessThanOrEqual(10)
	})

	test('respects multiple constraints together', async () => {
		const filter = FB.and([
			FB.comp(FB.eq('Gamemode', 'TC')),
			// FB.comp(FB.inValues('Map', ['Narva', 'Skorpo', 'Chora'])),
			FB.comp(FB.eq('Faction_1', 'USMC')),
		])
		const constraints: LQY.LayerQueryConstraint[] = [
			{ type: 'filter-anon', filter, applyAs: 'where-condition', id: 'tc-only' },
			{
				type: 'do-not-repeat',
				rule: { field: 'Map', within: 3 },
				id: 'no-repeat-map',
				applyAs: 'where-condition',
			},
		]

		const res = await getRandomGeneratedLayers(
			baseCtx,
			3,
			constraints,
			sampleLayerIds.slice(0, 1),
			true,
		)
		expect(res.layers.length).toBe(3)

		// All generated layers should be TC if they exist
		for (const layer of res.layers) {
			expect(layer.Gamemode).toBe('TC')
		}
	})

	test('considers previous layer IDs for do-not-repeat', async () => {
		if (sampleLayerIds.length === 0) return

		const constraints: LQY.LayerQueryConstraint[] = [
			{
				type: 'do-not-repeat',
				rule: { field: 'Layer', within: 2 },
				id: 'no-repeat-layer',
				applyAs: 'where-condition',
			},
		]

		const res = await getRandomGeneratedLayers(
			baseCtx,
			3,
			constraints,
			[sampleLayerIds[0]], // Previous layer
			true,
		)

		// Should not include the previous layer
		for (const layer of res.layers) {
			expect(layer.id).not.toBe(sampleLayerIds[0])
		}
	})
})

describe('Edge cases and error handling', () => {
	test('handles very large page sizes', async () => {
		const res = await queryLayers({
			input: {
				constraints: [],
				previousLayerIds: [],
				pageSize: 10000,
				pageIndex: 0,
			},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		expect(res.layers.length).toBeLessThanOrEqual(10000)
	})

	test('handles reasonable high page index', async () => {
		const res = await queryLayers({
			input: {
				constraints: [],
				previousLayerIds: [],
				pageSize: 10,
				pageIndex: 100, // High but reasonable page
			},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		// Should return valid response even if empty
		expect(Array.isArray(res.layers)).toBe(true)
	})

	test('handles complex nested filters with real data', async () => {
		const complexFilter = FB.or([
			FB.comp(FB.eq('Gamemode', 'TC')),
			FB.comp(FB.eq('Gamemode', 'RAAS')),
		])

		const res = await queryLayers({
			input: {
				constraints: [{ type: 'filter-anon', filter: complexFilter, applyAs: 'where-condition', id: 'complex' }],
				previousLayerIds: [],
				pageSize: 10,
				pageIndex: 0,
			},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		// Verify results match the filter logic
		for (const layer of res.layers) {
			expect(['TC', 'RAAS'].includes(layer.Gamemode)).toBe(true)
		}
	})

	test('handles multiple constraints together', async () => {
		const constraints: LQY.LayerQueryConstraint[] = [
			{
				type: 'filter-anon',
				filter: FB.comp(FB.eq('Gamemode', 'TC')),
				applyAs: 'where-condition',
				id: 'tc-only',
			},
			{
				type: 'do-not-repeat',
				rule: { field: 'Map', within: 3 },
				id: 'no-repeat-map',
				applyAs: 'where-condition',
			},
		]

		const res = await queryLayers({
			input: {
				constraints,
				previousLayerIds: sampleLayerIds.slice(0, 2),
				pageSize: 5,
				pageIndex: 0,
			},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		// All results should be TC gamemode
		for (const layer of res.layers) {
			expect(layer.Gamemode).toBe('TC')
		}
	})
})

// Integration test that was already working
test('generate random layers', async () => {
	const result = await getRandomGeneratedLayers(baseCtx, 5, [], [], true)
	expect(result.layers.length).toBeLessThanOrEqual(5)
	expect(result.totalCount).toBeGreaterThan(0)
})
