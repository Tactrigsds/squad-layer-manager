import * as Paths from '$root/paths'
import * as CS from '@/models/context-shared'
import * as F from '@/models/filter.models'
import * as LC from '@/models/layer-columns'
import * as LE from '@/models/layer-engine'
import { LayerEngine } from '@/systems/layer-engine.shared'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'

// The engine replaced a SQLite layer db, and filter semantics are where a columnar port goes wrong: null and NaN
// exclusion, and the negation of a comparison against null, which stays excluded rather than flipping true. So these
// expectations are not hand-written. They were recorded from the SQLite implementation the engine replaced, running
// the filters that actually run in production (test/fixtures/layer-engine-golden.json, see its `provenance`), and the
// engine has to keep reproducing them.
//
// Needs the built artifacts (`pnpm build:engine` and `pnpm preprocess build-layer-artifact`); skips without them.

const LAYERS_VERSION = '10.4.0'
const ARTIFACT_PATH = path.join(Paths.DATA, `layers_v${LAYERS_VERSION}.bin`)
const WASM_PATH = path.join(Paths.ASSETS, 'layer-engine.wasm')
const FIXTURES = path.join(Paths.PROJECT_ROOT, 'test', 'fixtures')

type Golden = {
	provenance: string
	layersVersion: string
	counts: Record<string, number>
	idSetDigests: Record<string, { count: number; sha256: string }>
	sortedPages: Record<string, (number | null)[]>
	distinct: Record<string, (number | null)[]>
	sampleIds: number[]
	exists: boolean[]
	matches: Record<string, boolean[]>
	ranges: Record<string, { min: number; max: number }>
}

const built = [ARTIFACT_PATH, WASM_PATH].every((p) => fs.existsSync(p))
const golden: Golden = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'layer-engine-golden.json'), 'utf8'))

describe.skipIf(!built)('layer engine', () => {
	let engine: LayerEngine
	let ctx: LE.LowerCtx
	let filters: Map<string, F.FilterNode>

	beforeAll(async () => {
		const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'prod-filters.json'), 'utf8')) as { id: string; filter: unknown }[]
		filters = new Map(raw.map((f) => [f.id, F.FilterNodeSchema.parse(f.filter)]))

		engine = await LayerEngine.create(fs.readFileSync(WASM_PATH), new Uint8Array(fs.readFileSync(ARTIFACT_PATH)))
		ctx = {
			...CS.init(),
			effectiveColsConfig: LC.getEffectiveColumnConfig(),
			filters: new Map([...filters].map(([id, filter]) => [id, { id, filter } as F.FilterEntity])),
			colIndex: (name: string) => engine.columnIndex(name),
		}
	})

	function lower(id: string): LE.Ir {
		const res = LE.lowerFilterNode(ctx, filters.get(id)!)
		if (res.code !== 'ok') throw new Error(`filter ${id} did not lower: ${JSON.stringify(res.errors)}`)
		return res.ir
	}

	function select(where: LE.Ir, args: { sort?: LE.Sort; pageSize?: number; columns?: number[] } = {}) {
		return engine.query<LE.SelectResponse>({
			kind: 'select',
			where,
			indicators: [],
			sort: args.sort ?? null,
			pageIndex: 0,
			pageSize: args.pageSize ?? 0,
			columns: args.columns ?? [],
		})
	}

	test('matches the same layers as the SQLite implementation, for every prod filter', () => {
		for (const id of Object.keys(golden.counts)) {
			expect(select(lower(id)).totalCount, `filter ${id}`).toBe(golden.counts[id])
		}
	})

	// these five between them cover the awkward corners: a negated range over a nullable float plus a negated
	// null-equality (imbalanced-layers), a column-to-column comparison (only-symmetric-units), team-column quantifiers
	// (cringe-unit-removal), and inlined filter references (main-pool, late-night-pool)
	test('returns exactly the same layer ids', () => {
		for (const [id, expected] of Object.entries(golden.idSetDigests)) {
			const res = select(lower(id), { pageSize: expected.count, columns: [engine.columnIndex('id')] })
			const ids = res.rows.map((row) => row[0]!).sort((a, b) => a - b)
			expect(ids.length, `filter ${id}`).toBe(expected.count)
			expect(crypto.createHash('sha256').update(ids.join(',')).digest('hex'), `filter ${id}`).toBe(expected.sha256)
		}
	})

	test.each(Object.keys(golden.sortedPages))('sorting by %s produces the same page, in the same order', (key) => {
		const column = key.slice(0, key.indexOf(':'))
		const dir = key.slice(column.length + 1) as 'ASC' | 'DESC' | 'ASC:ABS' | 'DESC:ABS'
		const res = select(lower('main-pool'), {
			sort: { column: { col: engine.columnIndex(column), dir } },
			pageSize: 50,
			columns: [engine.columnIndex(column)],
		})
		expect(res.rows.map((row) => row[0])).toEqual(golden.sortedPages[key])
	})

	test('distinct column values agree', () => {
		for (const [column, expected] of Object.entries(golden.distinct)) {
			const values = engine.query<(number | null)[]>({
				kind: 'distinct',
				where: lower('main-pool'),
				col: engine.columnIndex(column),
			}).sort((a, b) => Number(a) - Number(b))
			expect(values, column).toEqual(expected)
		}
	})

	test('layer existence and per-filter matches agree', () => {
		const filterIds = Object.keys(golden.matches)
		const res = engine.query<LE.MatchesResponse>({
			kind: 'matches',
			filters: filterIds.map(lower),
			ids: golden.sampleIds,
		})
		expect(res.exists).toEqual(golden.exists)
		for (let i = 0; i < filterIds.length; i++) {
			expect(res.matches[i], filterIds[i]).toEqual(golden.matches[filterIds[i]])
		}
	})

	test('score ranges agree', () => {
		const columns = Object.keys(golden.ranges)
		const res = engine.query<LE.RangeResponse[]>({
			kind: 'ranges',
			columns: columns.map((name) => engine.columnIndex(name)),
		})
		for (let i = 0; i < columns.length; i++) {
			expect(res[i].min, columns[i]).toBe(golden.ranges[columns[i]].min)
			expect(res[i].max, columns[i]).toBe(golden.ranges[columns[i]].max)
		}
	})

	// Generation is why the engine exists. Weights normalize against the groups that actually exist in the pool, so a
	// weight means what it says however rare its group is: under the old sampled algorithm a faction+unit matchup
	// weight topped out around 10% of draws no matter how large it was, because the pairing usually wasn't in the
	// sample at all.
	describe('weighted generation', () => {
		function draw(steps: LE.StepSpec[], pages: number) {
			const names = ['Faction_1', 'Unit_1', 'Faction_2', 'Unit_2', 'Gamemode']
			const columns = names.map((name) => engine.columnIndex(name))
			const layers: Record<string, number | null>[] = []
			for (let page = 0; page < pages; page++) {
				const res = engine.query<LE.SelectResponse>({
					kind: 'select',
					where: lower('main-pool'),
					indicators: [],
					sort: {
						random: { steps, defaultWeight: LC.DEFAULT_GENERATION_WEIGHT, seed: page + 1, numLayers: 10, excludeIds: [] },
					},
					pageIndex: 0,
					pageSize: 10,
					columns,
				})
				for (const row of res.rows) {
					layers.push(Object.fromEntries(names.map((name, i) => [name, row[i]])))
				}
			}
			return layers
		}

		const db = (column: LC.WeightColumn, value: string) => LC.dbValue(column, value, ctx) as number

		// this pairing is 74 of main-pool's 60,416 layers, and one of 484 faction+unit matchups in it. That is exactly
		// the case the old sampled algorithm could not serve: the pairing usually wasn't in the 5,000-layer sample, so
		// its weight had nothing to act on and it topped out around 10% of draws however large the weight was.
		test('a faction+unit matchup weight dominates the draw, even for a pairing that is 0.1% of the pool', () => {
			const values: Record<string, number> = {
				Faction_1: db('Faction_1', 'USA'),
				Unit_1: db('Unit_1', 'CombinedArms'),
				Faction_2: db('Faction_2', 'RGF'),
				Unit_2: db('Unit_2', 'CombinedArms'),
			}
			const key = LC.packStepKey('FactionUnitMatchup', (column) => values[column] ?? null)
			const layers = draw([{
				cols1: [engine.columnIndex('Faction_1'), engine.columnIndex('Unit_1')],
				radices1: [LC.weightColumnRadix('Faction_1'), LC.weightColumnRadix('Unit_1')],
				cols2: [engine.columnIndex('Faction_2'), engine.columnIndex('Unit_2')],
				radices2: [LC.weightColumnRadix('Faction_2'), LC.weightColumnRadix('Unit_2')],
				weights: [{ key, weight: 100_000 }],
			}], 10)

			const isTargetPairing = (layer: Record<string, number | null>) => {
				const sides = [[layer.Faction_1, layer.Unit_1], [layer.Faction_2, layer.Unit_2]]
				const combinedArms = db('Unit_1', 'CombinedArms')
				return sides.every(([faction, unit]) =>
					unit === combinedArms && (faction === db('Faction_1', 'USA') || faction === db('Faction_1', 'RGF'))
				) && sides[0][0] !== sides[1][0]
			}
			expect(layers.length).toBeGreaterThan(0)
			expect(layers.filter(isTargetPairing).length / layers.length).toBeGreaterThan(0.9)
		})

		test('the matchup is unordered: the pairing is drawn in both team orders', () => {
			const values: Record<string, number> = {
				Faction_1: db('Faction_1', 'ADF'),
				Unit_1: db('Unit_1', 'CombinedArms'),
				Faction_2: db('Faction_2', 'PLA'),
				Unit_2: db('Unit_2', 'CombinedArms'),
			}
			const key = LC.packStepKey('FactionUnitMatchup', (column) => values[column] ?? null)
			const layers = draw([{
				cols1: [engine.columnIndex('Faction_1'), engine.columnIndex('Unit_1')],
				radices1: [LC.weightColumnRadix('Faction_1'), LC.weightColumnRadix('Unit_1')],
				cols2: [engine.columnIndex('Faction_2'), engine.columnIndex('Unit_2')],
				radices2: [LC.weightColumnRadix('Faction_2'), LC.weightColumnRadix('Unit_2')],
				weights: [{ key, weight: 100_000 }],
			}], 10)

			const adfFirst = layers.filter((layer) => layer.Faction_1 === db('Faction_1', 'ADF')).length
			const plaFirst = layers.filter((layer) => layer.Faction_1 === db('Faction_1', 'PLA')).length
			expect(adfFirst).toBeGreaterThan(0)
			expect(plaFirst).toBeGreaterThan(0)
		})

		test('a weight of 0 excludes a group entirely', () => {
			const raas = db('Gamemode', 'RAAS')
			const layers = draw([{
				cols1: [engine.columnIndex('Gamemode')],
				radices1: [LC.weightColumnRadix('Gamemode')],
				weights: [{ key: LC.packSideKey(['Gamemode'], [raas]), weight: 0 }],
			}], 10)
			expect(layers.length).toBeGreaterThan(0)
			expect(layers.filter((layer) => layer.Gamemode === raas)).toHaveLength(0)
		})
	})
})
