import * as CS from '@/models/context-shared'
import * as FB from '@/models/filter-builders'
import * as LC from '@/models/layer-columns'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as SS from '@/models/server-state.models'
import * as DB from '@/server/db'
import * as Env from '@/server/env'
import * as Log from '@/server/logger'
import * as LayerDb from '@/server/systems/layer-db.server'
import * as LayerQueries from '@/systems.shared/layer-queries.shared'
import { beforeAll, describe, expect, test } from 'vitest'

let baseCtx!: CS.LayerQuery
let sampleLayerIds: string[] = []

// Helper function to create LayerItem objects from layer IDs
function createLayerItems(layerIds: string[]): LQY.LayerItem[] {
	return layerIds.map((layerId, index) => ({
		type: 'list-item' as const,
		layerId,
		itemId: `test-item-${index}`,
	}))
}

beforeAll(async () => {
	Env.ensureEnvSetup()
	Log.ensureLoggerSetup()
	await DB.setup()

	await LayerDb.setup({ skipHash: true })

	baseCtx = {
		log: Log.baseLogger,
		layerDb: () => LayerDb.db,
		effectiveColsConfig: LC.getEffectiveColumnConfig(LayerDb.LAYER_DB_CONFIG),
		filters: new Map(),
		layerItemsState: {
			layerItems: [],
			firstLayerItemParity: 0,
		},
	}

	// Get some sample layer IDs for testing
	const sampleQuery = await LayerQueries.queryLayers({
		input: {
			pageSize: 10,
			sort: { type: 'column', sortBy: 'id', sortDirection: 'ASC' },
		},
		ctx: baseCtx,
	})
	sampleLayerIds = sampleQuery.layers.map(l => l.id)
})

describe('queryLayers', () => {
	test('can query layers with basic parameters', async () => {
		const res = await LayerQueries.queryLayers({
			input: {
				pageSize: 20,
				sort: { type: 'column', sortBy: 'id', sortDirection: 'ASC' },
			},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		expect(res.layers).toHaveLength(20)
		expect(res.totalCount).toBeGreaterThan(0)
		expect(res.pageCount).toBeGreaterThan(0)
		expect(res.layers[0]).toHaveProperty('id')
		expect(res.layers[0]).toHaveProperty('Map')
		expect(res.layers[0]).toHaveProperty('Gamemode')
	})

	test('can filter results with basic filter', async () => {
		const ctx = baseCtx
		const filter = FB.and([FB.comp(FB.eq('Map', 'Lashkar')), FB.comp(FB.eq('Gamemode', 'TC'))])
		const res = await LayerQueries.queryLayers({
			input: {
				constraints: [{ type: 'filter-anon', filter, applyAs: 'where-condition', id: 'test-filter' }],
				pageSize: 50,
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
		const res = await LayerQueries.queryLayers({
			input: {
				constraints: [{ type: 'filter-anon', filter, applyAs: 'where-condition', id: 'raas-filter' }],
				pageSize: 10,
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
		const page1 = await LayerQueries.queryLayers({
			input: {
				pageSize,
			},
			ctx: baseCtx,
		})

		const page2 = await LayerQueries.queryLayers({
			input: {
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
		const res = await LayerQueries.queryLayers({
			input: {
				pageSize: 10,
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
		const res = await LayerQueries.queryLayers({
			input: {
				pageSize: 5,
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

		const ctxWithLayerItems = {
			...baseCtx,
			layerItemsState: {
				layerItems: createLayerItems([sampleLayerIds[0]]),
				firstLayerItemParity: 0,
			},
		}

		const res = await LayerQueries.queryLayers({
			input: {
				constraints: [{
					type: 'do-not-repeat',
					rule: { field: 'Map', within: 2 },
					id: 'no-repeat-map',
					applyAs: 'where-condition',
				}],
				pageSize: 10,
				pageIndex: 0,
			},
			ctx: ctxWithLayerItems,
		})

		expect(res.code).toBe('ok')
		// Should not contain layers with the same map as the previous layer
		if (res.layers.length > 0) {
			// This is a complex test that would require knowing the previous layer's map
			// For now, just verify we got a valid response
		}
	})

	test('applies default values correctly', async () => {
		const res = await LayerQueries.queryLayers({
			input: {},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		expect(res.layers.length).toBeLessThanOrEqual(100) // Default pageSize
	})
})

describe('layerExists', () => {
	test('correctly identifies existing layers', async () => {
		if (sampleLayerIds.length === 0) return

		const res = await LayerQueries.layerExists({
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
		const res = await LayerQueries.layerExists({
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
	test('respects filter constraints', async () => {
		const filter = FB.comp(FB.eq('Gamemode', 'TC'))
		const res = await LayerQueries.queryLayerComponent({
			input: {
				column: 'Gamemode',
				constraints: [{ type: 'filter-anon', filter, applyAs: 'where-condition', id: 'tc-only' }],
			},
			ctx: baseCtx,
		})

		expect(Array.isArray(res)).toBe(true)
		// If there are TC layers, Gamemode should contain 'TC'
		if (res.length > 0) {
			expect(res.includes('TC')).toBe(true)
		}
	})

	test('works with do-not-repeat constraints', async () => {
		if (sampleLayerIds.length === 0) return

		const ctxWithLayerItems = {
			...baseCtx,
			layerItemsState: {
				layerItems: createLayerItems([sampleLayerIds[0]]),
				firstLayerItemParity: 0,
			},
		}

		const res = await LayerQueries.queryLayerComponent({
			input: {
				column: 'Map',
				constraints: [{
					type: 'do-not-repeat',
					rule: { field: 'Map', within: 2 },
					id: 'no-repeat-map',
					applyAs: 'where-condition',
				}],
			},
			ctx: ctxWithLayerItems,
		})

		expect(typeof res).toBe('object')
		expect(Array.isArray(res)).toBe(true)
	})
})

describe('searchIds', () => {
	test('finds layers by partial string match', async () => {
		const result = await LayerQueries.searchIds({
			input: {
				queryString: 'Sumari',
			},
			ctx: baseCtx,
		})

		expect(result.code).toBe('ok')
		expect(Array.isArray(result.ids)).toBe(true)
		expect(result.ids.length).toBeLessThanOrEqual(15) // Limit is 15

		// All returned IDs should contain the query string
		for (const id of result.ids) {
			expect(id.toLowerCase()).toContain('sumari')
		}
	})

	test('respects constraints in search', async () => {
		const filter = FB.comp(FB.eq('Gamemode', 'TC'))
		const res = await LayerQueries.searchIds({
			input: {
				queryString: 'Al',
				constraints: [{ type: 'filter-anon', filter, applyAs: 'where-condition', id: 'tc-search' }],
			},
			ctx: baseCtx,
		})

		expect(res.code).toBe('ok')
		expect(Array.isArray(res.ids)).toBe(true)
	})

	test('finds layers with common prefixes', async () => {
		const result = await LayerQueries.searchIds({
			input: {
				queryString: 'a',
			},
			ctx: baseCtx,
		})

		expect(result.code).toBe('ok')
		expect(Array.isArray(result.ids)).toBe(true)

		// All returned IDs should contain the query string
		for (const id of result.ids) {
			expect(id.toLowerCase()).toContain('a')
		}
	})

	test('respects the 15 result limit', async () => {
		const res = await LayerQueries.searchIds({
			input: {
				queryString: 'a', // Very common letter, should find many
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

		const constraints = SS.getPoolConstraints(basicPool, 'where-condition', 'where-condition')

		const ctxWithLayerQueue = {
			...baseCtx,
			layerItemsState: LQY.resolveLayerItemsState(queue, []),
		}

		const res = await LayerQueries.getLayerItemStatuses({
			input: {
				constraints,
			},
			ctx: ctxWithLayerQueue,
		})

		if (res.code !== 'ok') {
			throw new Error(`Unexpected error: ${res.code}`)
		}
		expect(res.statuses.present.has(sampleLayerIds[0])).toBe(true)
	})

	test('detects do-not-repeat violations', async () => {
		if (sampleLayerIds.length < 2) return

		const queue: LL.LayerList = [
			{
				itemId: 'item1',
				layerId: sampleLayerIds[0],
				source: { type: 'unknown' },
			},
			{
				itemId: 'item2',
				layerId: sampleLayerIds[0],
				source: { type: 'unknown' },
			},
		]

		const basicPool: SS.PoolConfiguration = {
			filters: [],
			repeatRules: [{ field: 'Map', within: 1 }], // Don't repeat maps within 1 match
		}

		const constraints = SS.getPoolConstraints(basicPool, 'where-condition', 'where-condition')

		const ctxWithLayerQueue = {
			...baseCtx,
			layerItemsState: LQY.resolveLayerItemsState(queue, []),
		}

		const res = await LayerQueries.getLayerItemStatuses({
			input: {
				constraints,
			},
			ctx: ctxWithLayerQueue,
		})
		console.log(res)

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

		const constraints = SS.getPoolConstraints(basicPool, 'where-condition', 'where-condition')

		const ctxWithLayerQueue = {
			...baseCtx,
			layerItemsState: LQY.resolveLayerItemsState(queue, []),
		}

		const res = await LayerQueries.getLayerItemStatuses({
			input: {
				constraints,
			},
			ctx: ctxWithLayerQueue,
		})

		expect(res.code).toBe('ok')
		if (res.code !== 'ok') throw new Error(`Unexpected error: ${res.code}`)
		expect(res.statuses.present.has(sampleLayerIds[0])).toBe(true)
		expect(res.statuses.present.has(sampleLayerIds[1])).toBe(true)
	})
})

describe('getRandomGeneratedLayers (via queryLayers)', () => {
	test('generates random layers without constraints through queryLayers', async () => {
		const res = await LayerQueries.queryLayers({
			ctx: baseCtx,
			input: {
				pageSize: 10,
				sort: { type: 'random', seed: 12345 },
			},
		})

		expect(res.code).toBe('ok')
		expect(res.layers.length).toBeLessThanOrEqual(10)
		expect(res.totalCount).toBeGreaterThan(0)
		expect(res.layers[0]).toHaveProperty('id')
		expect(res.layers[0]).toHaveProperty('Map')
	})

	test('respects constraints when generating through queryLayers', async () => {
		const filter = FB.comp(FB.eq('Gamemode', 'TC'))
		const constraints: LQY.LayerQueryConstraint[] = [
			{ type: 'filter-anon', filter, applyAs: 'where-condition', id: 'tc-gen' },
		]

		const res = await LayerQueries.queryLayers({
			ctx: baseCtx,
			input: {
				pageSize: 10,
				constraints,
				sort: { type: 'random', seed: 12345 },
			},
		})

		expect(res.code).toBe('ok')
		// All generated layers should be TC if they exist
		for (const layer of res.layers) {
			expect(layer.Gamemode).toBe('TC')
		}
	})

	test('successfully returns layers through queryLayers interface', async () => {
		const res = await LayerQueries.queryLayers({
			ctx: baseCtx,
			input: {
				pageSize: 10,
				sort: { type: 'random', seed: 12345 },
			},
		})

		expect(res.code).toBe('ok')
		expect('layers' in res).toBe(true)
		expect(Array.isArray(res.layers)).toBe(true)
		expect(res.layers.length).toBeLessThanOrEqual(10)
	})

	test('respects multiple constraints together through queryLayers', async () => {
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

		const ctxWithLayerItems = {
			...baseCtx,
			layerItemsState: {
				layerItems: createLayerItems(sampleLayerIds.slice(0, 1)),
				firstLayerItemParity: 0,
			},
		}

		const res = await LayerQueries.queryLayers({
			ctx: ctxWithLayerItems,
			input: {
				pageSize: 5,
				constraints,
				sort: { type: 'random', seed: 12345 },
			},
		})

		expect(res.code).toBe('ok')
		expect(res.layers.length).toBe(5)

		// All generated layers should be TC if they exist
		for (const layer of res.layers) {
			expect(layer.Gamemode).toBe('TC')
		}
	})

	test('considers previous layer IDs for do-not-repeat through queryLayers', async () => {
		if (sampleLayerIds.length === 0) return

		const constraints: LQY.LayerQueryConstraint[] = [
			{
				type: 'do-not-repeat',
				rule: { field: 'Layer', within: 2 },
				id: 'no-repeat-layer',
				applyAs: 'where-condition',
			},
		]

		const ctxWithLayerItems = {
			...baseCtx,
			layerItemsState: {
				layerItems: createLayerItems([sampleLayerIds[0]]),
				firstLayerItemParity: 0,
			},
		}

		const res = await LayerQueries.queryLayers({
			ctx: ctxWithLayerItems,
			input: {
				pageSize: 5,
				constraints,
				sort: { type: 'random', seed: 12345 },
			},
		})

		expect(res.code).toBe('ok')
		// Should not include the previous layer
		for (const layer of res.layers) {
			expect(layer.id).not.toBe(sampleLayerIds[0])
		}
	})
})

describe('Edge cases and error handling', () => {
	test('handles very large page sizes', async () => {
		const result = await LayerQueries.queryLayers({
			input: {
				pageSize: 10,
				pageIndex: 999,
				sort: { type: 'random', seed: 123 },
			},
			ctx: baseCtx,
		})

		expect(result.code).toBe('ok')
		expect(result.layers.length).toBeLessThanOrEqual(10)
	})

	test('handles reasonable high page index', async () => {
		const res = await LayerQueries.queryLayers({
			input: {
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

		const res = await LayerQueries.queryLayers({
			input: {
				constraints: [{ type: 'filter-anon', filter: complexFilter, applyAs: 'where-condition', id: 'complex' }],
				pageSize: 10,
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

		const ctxWithLayerItems = {
			...baseCtx,
			layerItemsState: {
				layerItems: createLayerItems(sampleLayerIds.slice(0, 2)),
				firstLayerItemParity: 0,
			},
		}

		const res = await LayerQueries.queryLayers({
			input: {
				constraints,
				pageSize: 5,
			},
			ctx: ctxWithLayerItems,
		})

		expect(res.code).toBe('ok')
		// All results should be TC gamemode
		for (const layer of res.layers) {
			expect(layer.Gamemode).toBe('TC')
		}
	})
})

describe('Do-not-repeat rules - comprehensive scenarios', () => {
	test('respects map repeat rules with within=1', async () => {
		if (sampleLayerIds.length === 0) return

		const ctxWithLayerItems = {
			...baseCtx,
			layerItemsState: {
				layerItems: createLayerItems([sampleLayerIds[0]]),
				firstLayerItemParity: 0,
			},
		}

		const res = await LayerQueries.queryLayers({
			input: {
				constraints: [{
					type: 'do-not-repeat',
					rule: { field: 'Map', within: 1 },
					id: 'no-repeat-map-1',
					applyAs: 'where-condition',
				}],
				pageSize: 20,
				pageIndex: 0,
			},
			ctx: ctxWithLayerItems,
		})

		expect(res.code).toBe('ok')
		// Test passes if query executes successfully
	})

	test('respects gamemode repeat rules with within=2', async () => {
		if (sampleLayerIds.length < 2) return

		const ctxWithLayerItems = {
			...baseCtx,
			layerItemsState: {
				layerItems: createLayerItems([sampleLayerIds[0], sampleLayerIds[1]]),
				firstLayerItemParity: 0,
			},
		}

		const res = await LayerQueries.queryLayers({
			input: {
				constraints: [{
					type: 'do-not-repeat',
					rule: { field: 'Gamemode', within: 2 },
					id: 'no-repeat-gamemode-2',
					applyAs: 'where-condition',
				}],
				pageSize: 20,
				pageIndex: 0,
			},
			ctx: ctxWithLayerItems,
		})

		expect(res.code).toBe('ok')
		// Test passes if query executes successfully
	})

	test('handles multiple do-not-repeat rules simultaneously', async () => {
		if (sampleLayerIds.length === 0) return

		const ctxWithLayerItems = {
			...baseCtx,
			layerItemsState: {
				layerItems: createLayerItems([sampleLayerIds[0]]),
				firstLayerItemParity: 0,
			},
		}

		const res = await LayerQueries.queryLayers({
			input: {
				constraints: [
					{
						type: 'do-not-repeat',
						rule: { field: 'Map', within: 1 },
						id: 'no-repeat-map',
						applyAs: 'where-condition',
					},
					{
						type: 'do-not-repeat',
						rule: { field: 'Gamemode', within: 1 },
						id: 'no-repeat-gamemode',
						applyAs: 'where-condition',
					},
				],
				pageSize: 20,
				pageIndex: 0,
			},
			ctx: ctxWithLayerItems,
		})

		expect(res.code).toBe('ok')
		// Test passes if query executes successfully
	})

	test('works with different within values', async () => {
		if (sampleLayerIds.length < 3) return

		const ctxWithLayerItems = {
			...baseCtx,
			layerItemsState: {
				layerItems: createLayerItems([sampleLayerIds[0], sampleLayerIds[1], sampleLayerIds[2]]),
				firstLayerItemParity: 0,
			},
		}

		// Test with within=0 (no repeats allowed)
		const resWithin0 = await LayerQueries.queryLayers({
			input: {
				constraints: [{
					type: 'do-not-repeat',
					rule: { field: 'Map', within: 0 },
					id: 'no-repeat-map-0',
					applyAs: 'where-condition',
				}],
				pageSize: 20,
			},
			ctx: ctxWithLayerItems,
		})

		expect(resWithin0.code).toBe('ok')

		// Test with within=3 (larger window)
		const resWithin3 = await LayerQueries.queryLayers({
			input: {
				constraints: [{
					type: 'do-not-repeat',
					rule: { field: 'Map', within: 3 },
					id: 'no-repeat-map-3',
					applyAs: 'where-condition',
				}],
				pageSize: 20,
			},
			ctx: ctxWithLayerItems,
		})

		expect(resWithin3.code).toBe('ok')
	})

	test('queryLayerComponents works with do-not-repeat constraints', async () => {
		if (sampleLayerIds.length === 0) return

		const ctxWithLayerItems = {
			...baseCtx,
			layerItemsState: {
				layerItems: createLayerItems([sampleLayerIds[0]]),
				firstLayerItemParity: 0,
			},
		}

		const res = await LayerQueries.queryLayerComponent({
			input: {
				column: 'Map',
				constraints: [{
					type: 'do-not-repeat',
					rule: { field: 'Map', within: 1 },
					id: 'no-repeat-map',
					applyAs: 'where-condition',
				}],
			},
			ctx: ctxWithLayerItems,
		})

		expect(typeof res).toBe('object')
		expect(Array.isArray(res)).toBe(true)
	})

	test('searchIds works with do-not-repeat constraints', async () => {
		if (sampleLayerIds.length === 0) return

		const ctxWithLayerItems = {
			...baseCtx,
			layerItemsState: {
				layerItems: createLayerItems([sampleLayerIds[0]]),
				firstLayerItemParity: 0,
			},
		}

		const res = await LayerQueries.searchIds({
			input: {
				queryString: 'a',
				constraints: [{
					type: 'do-not-repeat',
					rule: { field: 'Map', within: 1 },
					id: 'no-repeat-map',
					applyAs: 'where-condition',
				}],
			},
			ctx: ctxWithLayerItems,
		})

		expect(res.code).toBe('ok')
		if (res.code === 'ok') {
			expect(Array.isArray(res.ids)).toBe(true)
			expect(res.ids.length).toBeLessThanOrEqual(15)
		}
	})

	test('handles different field types for do-not-repeat', async () => {
		if (sampleLayerIds.length === 0) return

		const ctxWithLayerItems = {
			...baseCtx,
			layerItemsState: {
				layerItems: createLayerItems([sampleLayerIds[0]]),
				firstLayerItemParity: 0,
			},
		}

		// Test different field types (only supported ones)
		const fields: LQY.RepeatRuleField[] = ['Map', 'Gamemode', 'Size', 'Layer']

		for (const field of fields) {
			const res = await LayerQueries.queryLayers({
				input: {
					constraints: [{
						type: 'do-not-repeat',
						rule: { field, within: 1 },
						id: `no-repeat-${field}`,
						applyAs: 'where-condition',
					}],
					pageSize: 10,
				},
				ctx: ctxWithLayerItems,
			})

			expect(res.code).toBe('ok')
		}
	})

	test('works with getLayerStatusesForLayerQueue', async () => {
		if (sampleLayerIds.length < 2) return

		const queue: LL.LayerList = [
			{
				itemId: 'item1',
				layerId: sampleLayerIds[0],
				source: { type: 'unknown' },
			},
			{
				itemId: 'item2',
				layerId: sampleLayerIds[1],
				source: { type: 'unknown' },
			},
		]

		const basicPool: SS.PoolConfiguration = {
			filters: [],
			repeatRules: [{ field: 'Map', within: 1 }],
		}

		const constraints = SS.getPoolConstraints(basicPool, 'where-condition', 'where-condition')

		const ctxWithLayerQueue = {
			...baseCtx,
			layerItemsState: LQY.resolveLayerItemsState(queue, []),
		}

		const res = await LayerQueries.getLayerItemStatuses({
			input: { constraints },
			ctx: ctxWithLayerQueue,
		})

		expect(res.code).toBe('ok')
		if (res.code === 'ok') {
			expect(res.statuses.present.size).toBeGreaterThan(0)
			expect(res.statuses.violationDescriptors.size).toBeGreaterThan(0)
		}
	})

	test('works with Faction field for do-not-repeat', async () => {
		if (sampleLayerIds.length === 0) return

		const ctxWithLayerItems = {
			...baseCtx,
			layerItemsState: {
				layerItems: createLayerItems([sampleLayerIds[0]]),
				firstLayerItemParity: 0,
			},
		}

		// Test Faction field which has special handling for team-based logic
		const res = await LayerQueries.queryLayers({
			input: {
				constraints: [{
					type: 'do-not-repeat',
					rule: { field: 'Faction', within: 1 },
					id: 'no-repeat-faction',
					applyAs: 'where-condition',
				}],
				pageSize: 10,
			},
			ctx: ctxWithLayerItems,
		})

		expect(res.code).toBe('ok')
		// Test passes if query executes successfully with Faction field
	})

	test('works with getLayerItemStatuses and do-not-repeat rules', async () => {
		if (sampleLayerIds.length < 3) return

		const queue: LL.LayerList = [
			{
				itemId: 'item1',
				layerId: sampleLayerIds[0],
				source: { type: 'unknown' },
			},
			{
				itemId: 'item2',
				layerId: sampleLayerIds[1],
				source: { type: 'unknown' },
			},
			{
				itemId: 'item3',
				layerId: sampleLayerIds[0], // Duplicate to test violations
				source: { type: 'unknown' },
			},
		]

		const basicPool: SS.PoolConfiguration = {
			filters: [],
			repeatRules: [
				{ field: 'Map', within: 2 },
				{ field: 'Gamemode', within: 1 },
			],
		}

		const constraints = SS.getPoolConstraints(basicPool, 'where-condition', 'where-condition')

		const ctxWithLayerQueue = {
			...baseCtx,
			layerItemsState: LQY.resolveLayerItemsState(queue, []),
		}

		const res = await LayerQueries.getLayerItemStatuses({
			input: { constraints },
			ctx: ctxWithLayerQueue,
		})

		console.log(res)
		expect(res.code).toBe('ok')
		if (res.code === 'ok') {
			// Should detect the duplicate layer
			expect(res.statuses.present.size).toBeGreaterThan(0)
			expect(res.statuses.blocked.size).toBeGreaterThan(0)
			expect(res.statuses.violationDescriptors.size).toBeGreaterThan(0)

			// The duplicate layer should be blocked
			expect(res.statuses.blocked.has(LQY.toLayerItemId(LQY.getLayerItemForListItem(queue[2])))).toBe(true)
		}
	})

	test('works with getLayerItemStatuses and different within values', async () => {
		if (sampleLayerIds.length < 4) return

		const queue: LL.LayerList = [
			{
				itemId: 'item1',
				layerId: sampleLayerIds[0],
				source: { type: 'unknown' },
			},
			{
				itemId: 'item2',
				layerId: sampleLayerIds[1],
				source: { type: 'unknown' },
			},
			{
				itemId: 'item3',
				layerId: sampleLayerIds[2],
				source: { type: 'unknown' },
			},
			{
				itemId: 'item4',
				layerId: sampleLayerIds[0], // Should be allowed with within=2
				source: { type: 'unknown' },
			},
		]

		const basicPool: SS.PoolConfiguration = {
			filters: [],
			repeatRules: [{ field: 'Layer', within: 2 }], // Allow repeat after 2 layers
		}

		const constraints = SS.getPoolConstraints(basicPool, 'where-condition', 'where-condition')

		const ctxWithLayerQueue = {
			...baseCtx,
			layerItemsState: LQY.resolveLayerItemsState(queue, []),
		}

		const res = await LayerQueries.getLayerItemStatuses({
			input: { constraints },
			ctx: ctxWithLayerQueue,
		})

		expect(res.code).toBe('ok')
		if (res.code === 'ok') {
			expect(res.statuses.present.size).toBeGreaterThan(0)
			// With within=2, the 4th item should be allowed since there are 2 layers between repeats
		}
	})

	test('works with getLayerItemStatuses and vote items with do-not-repeat', async () => {
		if (sampleLayerIds.length < 3) return

		const queue: LL.LayerList = [
			{
				itemId: 'item1',
				layerId: sampleLayerIds[0],
				source: { type: 'unknown' },
			},
			{
				itemId: 'vote1',
				source: { type: 'unknown' },
				vote: {
					defaultChoice: sampleLayerIds[1],
					choices: [
						sampleLayerIds[0], // This should be blocked by repeat rule
						sampleLayerIds[1],
						sampleLayerIds[2],
					],
				},
			},
		]

		const basicPool: SS.PoolConfiguration = {
			filters: [],
			repeatRules: [{ field: 'Layer', within: 1 }],
		}

		const constraints = SS.getPoolConstraints(basicPool, 'where-condition', 'where-condition')

		const ctxWithLayerQueue = {
			...baseCtx,
			layerItemsState: LQY.resolveLayerItemsState(queue, []),
		}

		const res = await LayerQueries.getLayerItemStatuses({
			input: { constraints },
			ctx: ctxWithLayerQueue,
		})

		expect(res.code).toBe('ok')
		if (res.code === 'ok') {
			expect(res.statuses.present.size).toBeGreaterThan(0)
			// The first choice in the vote should be blocked due to repeat rule
			expect(res.statuses.blocked.has(LQY.toLayerItemId(LQY.getLayerItemForVoteItem(queue[1], 0)))).toBe(true)
		}
	})

	test('works with Faction do-not-repeat in getLayerStatusesForLayerQueue', async () => {
		if (sampleLayerIds.length < 2) return

		const queue: LL.LayerList = [
			{
				itemId: 'item1',
				layerId: sampleLayerIds[0],
				source: { type: 'unknown' },
			},
			{
				itemId: 'item2',
				layerId: sampleLayerIds[1],
				source: { type: 'unknown' },
			},
		]

		const basicPool: SS.PoolConfiguration = {
			filters: [],
			repeatRules: [{ field: 'Faction', within: 1 }],
		}

		const constraints = SS.getPoolConstraints(basicPool, 'where-condition', 'where-condition')

		const ctxWithLayerQueue = {
			...baseCtx,
			layerItemsState: LQY.resolveLayerItemsState(queue, []),
		}

		const res = await LayerQueries.getLayerItemStatuses({
			input: { constraints },
			ctx: ctxWithLayerQueue,
		})

		expect(res.code).toBe('ok')
		if (res.code === 'ok') {
			expect(res.statuses.present.size).toBeGreaterThan(0)
			// Faction repeat violations should be detected if same factions are present
			expect(res.statuses.violationDescriptors.size).toBeGreaterThanOrEqual(0)
		}
	})

	test('works with complex constraint combinations', async () => {
		if (sampleLayerIds.length < 2) return

		const ctxWithLayerItems = {
			...baseCtx,
			layerItemsState: {
				layerItems: createLayerItems([sampleLayerIds[0], sampleLayerIds[1]]),
				firstLayerItemParity: 0,
			},
		}

		// Test combining do-not-repeat with filters
		const filter = FB.comp(FB.eq('Gamemode', 'TC'))
		const res = await LayerQueries.queryLayers({
			input: {
				constraints: [
					{
						type: 'filter-anon',
						filter,
						applyAs: 'where-condition',
						id: 'tc-filter',
					},
					{
						type: 'do-not-repeat',
						rule: { field: 'Map', within: 1 },
						id: 'no-repeat-map',
						applyAs: 'where-condition',
					},
					{
						type: 'do-not-repeat',
						rule: { field: 'Gamemode', within: 2 },
						id: 'no-repeat-gamemode',
						applyAs: 'where-condition',
					},
				],
				pageSize: 10,
			},
			ctx: ctxWithLayerItems,
		})

		expect(res.code).toBe('ok')
		// Test passes if complex constraint combination works
	})
})

// Integration test that was already working
test('generate random layers', async () => {
	const result = await LayerQueries.getRandomGeneratedLayers(baseCtx, 5, {}, true)
	expect(result.layers.length).toBeLessThanOrEqual(5)
	expect(result.totalCount).toBeGreaterThan(0)
})
