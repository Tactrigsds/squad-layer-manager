import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { beforeAll, describe, expect, it } from 'vitest'

import * as Paths from '$root/paths'
import * as CB from '@/models/constraint-builders'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import type * as LQY from '@/models/layer-queries.models'
import * as LayerArtifacts from '@/systems/layer-artifacts.server'
import { LayerEngine } from '@/systems/layer-engine.shared'
import { getLayerItemStatuses, type QueryCtx, solveRepeatViolations } from '@/systems/layer-queries.shared'

// The solver's search runs in the engine and is checked against brute force in layer-engine/src/solve.rs. This checks
// the other half: that what solveRepeatViolations encodes for the engine means what the queue warnings mean. The
// engine wasm is a build artifact (`pnpm build:engine`), so without it there is nothing to run.
const WASM_PATH = path.join(Paths.ASSETS, 'layer-engine.wasm')

const CONSTRAINTS = [
	CB.repeatRule('map', { field: 'Map', within: 4 }),
	CB.repeatRule('faction', { field: 'Faction', within: 2 }),
	CB.repeatRule('unit', { field: 'Unit', within: 1, crossTeam: true }),
	CB.repeatRule('matchup', { field: 'UnitMatchup', within: 3 }),
	// shown but not warned about, so the solver ignores it
	CB.repeatRule('gamemode', { field: 'Gamemode', within: 2 }, { warn: false }),
]

let ctx: QueryCtx
let pool: L.LayerId[]

function rng(seed: number) {
	let state = seed
	return (n: number) => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0
		return state % n
	}
}

function repeatWarnings(list: LQY.LayerItemsState) {
	return getLayerItemStatuses({ ctx, input: { list, constraints: CONSTRAINTS } }).then((res) => {
		if (res.code !== 'ok') throw new Error('statuses failed')
		return res.statuses.warns.filter((warn) => warn.type === 'repeat-rule-violation-warning').length
	})
}

describe.skipIf(!fs.existsSync(WASM_PATH))('solveRepeatViolations', () => {
	beforeAll(async () => {
		const pair = LayerArtifacts.resolvePair()
		const bytes = fs.readFileSync(pair.tableLoadPath)
		const artifact = pair.tableLoadPath.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes
		const engine = await LayerEngine.create(fs.readFileSync(WASM_PATH), artifact)
		ctx = { ...CS.init(), effectiveColsConfig: LC.getEffectiveColumnConfig(), filters: new Map(), engine } as unknown as QueryCtx

		// a handful of maps, so the random queues repeat often
		const gamemodes = ['RAAS', 'Invasion'].map((value) => Number(LC.dbValue('Gamemode', value, ctx)))
		const page = engine.query<{ rows: number[][] }>({
			kind: 'select',
			where: { op: 'in_vals', col: engine.columnIndex('Gamemode'), vals: gamemodes },
			indicators: [],
			sort: null,
			pageIndex: 0,
			pageSize: 20_000,
			columns: [engine.columnIndex('id')],
		})
		const ids = page.rows.map(([id]) => LC.unpackId(id))
		const maps = [...new Set(ids.map((id) => L.toLayer(id).Map))].slice(0, 6)
		const pick = rng(1)
		pool = ids.filter((id) => maps.includes(L.toLayer(id).Map as string)).filter(() => pick(20) === 0)
	})

	it('reports the warnings its arrangement actually leaves', async () => {
		const pick = rng(7)
		let improved = 0
		for (let trial = 0; trial < 40; trial++) {
			const history = Array.from({ length: 3 }, (_, i) => ({
				type: 'match-history-entry' as const,
				itemId: i,
				layerId: pool[pick(pool.length)],
			}))
			const queue = Array.from({ length: 4 + pick(6) }, (_, i) => ({
				type: 'single-list-item' as const,
				itemId: `item-${trial}-${i}`,
				layerId: pool[pick(pool.length)],
			}))
			const list: LQY.LayerItemsState = { layerItems: [...history, ...queue], firstLayerItemParity: pick(2) }

			const res = await solveRepeatViolations({ ctx, input: { list, constraints: CONSTRAINTS } })
			if (res.code !== 'ok') throw new Error(res.code)
			expect(res.status).toBe('optimal')
			expect(res.baselineViolations).toBe(await repeatWarnings(list))

			const byId = new Map(queue.map((item) => [item.itemId, item]))
			const swapped = new Set(res.swapped)
			const arranged = res.order.map((itemId) => {
				const item = byId.get(itemId as string)!
				if (!swapped.has(itemId)) return item
				expect(L.toLayer(item.layerId).Gamemode).not.toBe('Invasion')
				return { ...item, layerId: L.swapFactionsInId(item.layerId) }
			})
			expect(await repeatWarnings({ ...list, layerItems: [...history, ...arranged] })).toBe(res.violations)
			expect(res.violations).toBeLessThanOrEqual(res.baselineViolations)
			if (res.violations < res.baselineViolations) improved++
		}
		// guards against a fixture that never gives the solver anything to do
		expect(improved).toBeGreaterThan(10)
	})

	it('keeps pinned items and no-swap tags in place', async () => {
		const [a, b] = pool.filter((id) => L.toLayer(id).Gamemode === 'RAAS')
		// the same layer back to back breaks the map rule whatever the teams, so one of them has to move
		const queue = [
			{ type: 'single-list-item' as const, itemId: 'pinned', layerId: a },
			{ type: 'single-list-item' as const, itemId: 'repeat', layerId: a, tags: ['locked:aaaaaa'] },
			{ type: 'single-list-item' as const, itemId: 'other', layerId: b },
		]
		const list: LQY.LayerItemsState = { layerItems: queue, firstLayerItemParity: 0 }
		const res = await solveRepeatViolations({
			ctx,
			input: { list, constraints: CONSTRAINTS, pinnedItemIds: ['pinned'], noSwapTags: ['locked:aaaaaa'] },
		})
		if (res.code !== 'ok') throw new Error(res.code)
		expect(res.order[0]).toBe('pinned')
		expect(res.swapped).not.toContain('pinned')
		expect(res.swapped).not.toContain('repeat')
	})
})
