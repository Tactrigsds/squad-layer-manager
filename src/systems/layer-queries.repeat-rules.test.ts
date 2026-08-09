import { describe, expect, it } from 'vitest'

import * as PoolCheckboxesPrt from '@/frame-partials/pool-checkboxes.partial'
import * as CB from '@/models/constraint-builders'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import type * as LE from '@/models/layer-engine'
import type * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as SETTINGS from '@/models/settings.models'
import { buildQueryConstraints, getLayerItemStatuses, getRepeatRuleMatchDescriptors, type QueryCtx } from '@/systems/layer-queries.shared'

// Team A of the previous match played USA, team B played RGF.
const PREVIOUS = 'GD-RAAS-V1:USA-CA:RGF-CA'
// teams alternate slots, so at the cursor these read team A = RGF, team B = USA: the same two factions, sides swapped
const SIDES_SWAPPED = 'NV-RAAS-V1:USA-CA:RGF-CA'
const SAME_SIDES = 'NV-RAAS-V1:RGF-CA:USA-CA'

// Team A of the previous match ran Mechanized, team B ran AirAssault. Queueing this same layer again swaps which
// team holds which unit, because the parity flips: at the cursor team A runs AirAssault and team B Mechanized.
const PREVIOUS_UNITS = 'HJ-RAAS-V1:RGF-MZ:PLA-AA'
// team A = Mechanized, matching the previous team A; team B = Armored, matching nothing. As a matchup this is
// Armored vs Mechanized, which is not the previous matchup at all.
const UNITS_ONE_SIDE = 'FL-RAAS-V2:TLF-AR:ADF-MZ'
// the same two units as PREVIOUS_UNITS with the slots swapped: a different layer, the same matchup
const UNITS_REVERSED = 'HJ-RAAS-V1:PLA-AA:RGF-MZ'
// both sides run CombinedArms, so the matchup is its own mirror
const PREVIOUS_MIRROR_UNITS = 'NV-RAAS-V1:USA-CA:RGF-CA'

const COLUMNS = Object.keys(LC.BASE_COLUMN_CONFIG.defs)

const ctx = {
	...CS.init(),
	effectiveColsConfig: LC.BASE_COLUMN_CONFIG,
	filters: new Map(),
	engine: {
		columnIndex: (name: string) => COLUMNS.indexOf(name),
		// these cases carry no filter-entity constraint, so getLayerItemStatuses only reads `exists`
		query: (q: { ids?: unknown[] }) => ({ exists: (q.ids ?? []).map(() => true), matches: [] }),
	},
} as unknown as QueryCtx

const col = (name: string) => COLUMNS.indexOf(name)
const faction = (value: string) => Number(LC.dbValue('Faction_1', value, ctx))
const unit = (value: string) => Number(LC.dbValue('Unit_1', value, ctx))

// one played match, so the cursor sits at index 1 and the target match has the opposite team parity: its team A is
// the _2 slot
const listAfter = (layerId: string): LQY.LayerItemsState => ({
	layerItems: [{ type: 'match-history-entry', itemId: 1, layerId }],
	firstLayerItemParity: 0,
})

const list = listAfter(PREVIOUS)
const unitList = listAfter(PREVIOUS_UNITS)

function whereFor(rule: LQY.RepeatRule, itemsState = list) {
	const compiled = buildQueryConstraints(ctx, {
		constraints: [CB.repeatRule('rule', rule, { filterApplState: 'regular' })],
		list: itemsState,
		cursor: { type: 'end' },
	})
	if (compiled.code !== 'ok') throw new Error('expected the constraints to compile')
	return compiled.where
}

function inVals(where: LE.Ir): { col: number; vals: number[] }[] {
	if (where.op === 'and' || where.op === 'or') return where.children.flatMap(inVals)
	if (where.op === 'in_vals') return [{ col: where.col, vals: [...where.vals].sort((a, b) => a - b) }]
	return []
}

const ascending = (a: number, b: number) => a - b

describe('a Faction repeat rule', () => {
	it('holds each team to its own history by default', () => {
		const clauses = inVals(whereFor({ label: 'Faction', field: 'Faction', within: 3 }))
		expect(clauses).toEqual([
			{ col: col('Faction_2'), vals: [faction('USA')] },
			{ col: col('Faction_1'), vals: [faction('RGF')] },
		])
	})

	it('pools both teams under crossTeam', () => {
		const clauses = inVals(whereFor({ label: 'Faction', field: 'Faction', within: 3, crossTeam: true }))
		const pooled = [faction('USA'), faction('RGF')].sort(ascending)
		expect(clauses).toEqual([
			{ col: col('Faction_2'), vals: pooled },
			{ col: col('Faction_1'), vals: pooled },
		])
	})

	it('still respects targetValues under crossTeam', () => {
		const clauses = inVals(whereFor({ label: 'Faction', field: 'Faction', within: 3, crossTeam: true, targetValues: ['RGF'] }))
		expect(clauses).toEqual([
			{ col: col('Faction_2'), vals: [faction('RGF')] },
			{ col: col('Faction_1'), vals: [faction('RGF')] },
		])
	})
})

describe('a Unit repeat rule', () => {
	it('holds each team to its own history by default', () => {
		const clauses = inVals(whereFor({ label: 'Unit', field: 'Unit', within: 3 }, unitList))
		expect(clauses).toEqual([
			{ col: col('Unit_2'), vals: [unit('Mechanized')] },
			{ col: col('Unit_1'), vals: [unit('AirAssault')] },
		])
	})

	it('pools both teams under crossTeam', () => {
		const clauses = inVals(whereFor({ label: 'Unit', field: 'Unit', within: 3, crossTeam: true }, unitList))
		const pooled = [unit('Mechanized'), unit('AirAssault')].sort(ascending)
		expect(clauses).toEqual([
			{ col: col('Unit_2'), vals: pooled },
			{ col: col('Unit_1'), vals: pooled },
		])
	})
})

describe('a UnitMatchup repeat rule', () => {
	const orientation = (first: string, second: string) => ({
		op: 'and',
		children: [
			{ op: 'in_vals', col: col('Unit_1'), vals: [unit(first)] },
			{ op: 'in_vals', col: col('Unit_2'), vals: [unit(second)] },
		],
	})

	it('matches the previous matchup in either orientation', () => {
		expect(whereFor({ label: 'Unit Matchup', field: 'UnitMatchup', within: 3 }, unitList)).toEqual({
			op: 'or',
			children: [orientation('Mechanized', 'AirAssault'), orientation('AirAssault', 'Mechanized')],
		})
	})

	it('is unaffected by crossTeam, having no per-team reading to widen', () => {
		const rule = { label: 'Unit Matchup', field: 'UnitMatchup', within: 3 } as const
		expect(whereFor({ ...rule, crossTeam: true }, unitList)).toEqual(whereFor(rule, unitList))
	})

	it('collapses a mirror matchup to a single orientation', () => {
		const mirrorList = listAfter(PREVIOUS_MIRROR_UNITS)
		expect(whereFor({ label: 'Unit Matchup', field: 'UnitMatchup', within: 3 }, mirrorList)).toEqual(
			orientation('CombinedArms', 'CombinedArms'),
		)
	})

	it('drops a matchup no target value names', () => {
		const rule: LQY.RepeatRule = {
			label: 'Unit Matchup',
			field: 'UnitMatchup',
			within: 3,
			targetValues: [LQY.unitMatchupValue('Armored', 'Mechanized')],
		}
		expect(whereFor(rule, unitList)).toEqual({ op: 'false' })
	})

	it('keeps a matchup a target value names, whichever way round it is written', () => {
		const expected = {
			op: 'or',
			children: [orientation('Mechanized', 'AirAssault'), orientation('AirAssault', 'Mechanized')],
		}
		for (const targetValue of [LQY.unitMatchupValue('Mechanized', 'AirAssault'), LQY.unitMatchupValue('AirAssault', 'Mechanized')]) {
			expect(whereFor({ label: 'Unit Matchup', field: 'UnitMatchup', within: 3, targetValues: [targetValue] }, unitList)).toEqual(
				expected,
			)
		}
	})
})

describe('the unit matchup options offered in settings', () => {
	it('offers every unordered pairing of the units, mirrors included, and nothing twice', () => {
		const options = LQY.unitMatchupOptions(['Armored', 'Mechanized', 'AirAssault'])
		expect(options).toEqual([
			'AirAssault vs AirAssault',
			'AirAssault vs Armored',
			'AirAssault vs Mechanized',
			'Armored vs Armored',
			'Armored vs Mechanized',
			'Mechanized vs Mechanized',
		])
		expect(new Set(options).size).toBe(options.length)
	})

	it('produces the same value the evaluator compares against', () => {
		expect(LQY.unitMatchupOptions(['Mechanized', 'AirAssault'])).toContain(LQY.unitMatchupValue('Mechanized', 'AirAssault'))
	})
})

describe('the match descriptors a UnitMatchup repeat rule produces', () => {
	const fieldsFor = (rule: LQY.RepeatRule, layerId: string) =>
		(getRepeatRuleMatchDescriptors(unitList, 1, 'rule', rule, layerId) ?? []).map((d) => d.field)

	const rule: LQY.RepeatRule = { label: 'Unit Matchup', field: 'UnitMatchup', within: 3 }

	it('reports both sides when the same matchup comes back', () => {
		expect(fieldsFor(rule, PREVIOUS_UNITS)).toEqual(['UnitMatchup_A', 'UnitMatchup_B'])
	})

	it('reports the repeat even though the two sides have swapped', () => {
		expect(fieldsFor(rule, UNITS_REVERSED)).toEqual(['UnitMatchup_A', 'UnitMatchup_B'])
	})

	it('reports nothing for a matchup that only shares one unit', () => {
		expect(fieldsFor(rule, UNITS_ONE_SIDE)).toEqual([])
	})

	it('reports nothing when no target value names the matchup', () => {
		const targetValues = [LQY.unitMatchupValue('Armored', 'Mechanized')]
		expect(fieldsFor({ ...rule, targetValues }, PREVIOUS_UNITS)).toEqual([])
	})

	it('still reports when a target value names this matchup', () => {
		const targetValues = [LQY.unitMatchupValue('AirAssault', 'Mechanized')]
		expect(fieldsFor({ ...rule, targetValues }, UNITS_REVERSED)).toEqual(['UnitMatchup_A', 'UnitMatchup_B'])
	})
})

describe('the match descriptors a Faction repeat rule produces', () => {
	const fieldsFor = (rule: LQY.RepeatRule, layerId: string) =>
		(getRepeatRuleMatchDescriptors(list, 1, 'rule', rule, layerId) ?? []).map((d) => d.field)
	const fieldPairsFor = (rule: LQY.RepeatRule, layerId: string) =>
		(getRepeatRuleMatchDescriptors(list, 1, 'rule', rule, layerId) ?? []).map((d) => [d.field, d.sourceField])

	const rule: LQY.RepeatRule = { label: 'Faction', field: 'Faction', within: 3 }
	const crossTeamRule: LQY.RepeatRule = { ...rule, crossTeam: true }

	it('reports nothing when only the other team played the faction', () => {
		expect(fieldsFor(rule, SIDES_SWAPPED)).toEqual([])
	})

	it('reports both teams under crossTeam when the sides are swapped', () => {
		expect(fieldsFor(crossTeamRule, SIDES_SWAPPED)).toEqual(['Faction_A', 'Faction_B'])
	})

	it('points each crossTeam descriptor at the source team that actually played the faction', () => {
		expect(fieldPairsFor(crossTeamRule, SIDES_SWAPPED)).toEqual([
			['Faction_A', 'Faction_B'],
			['Faction_B', 'Faction_A'],
		])
	})

	it('reports one descriptor per team when both teams repeat their own faction', () => {
		expect(fieldsFor(rule, SAME_SIDES)).toEqual(['Faction_A', 'Faction_B'])
		expect(fieldsFor(crossTeamRule, SAME_SIDES)).toEqual(['Faction_A', 'Faction_B'])
		expect(fieldPairsFor(crossTeamRule, SAME_SIDES)).toEqual([
			['Faction_A', 'Faction_A'],
			['Faction_B', 'Faction_B'],
		])
	})
})

describe('the match descriptors a Unit repeat rule produces', () => {
	const fieldsFor = (rule: LQY.RepeatRule, layerId: string) =>
		(getRepeatRuleMatchDescriptors(unitList, 1, 'rule', rule, layerId) ?? []).map((d) => d.field)
	const fieldPairsFor = (rule: LQY.RepeatRule, layerId: string) =>
		(getRepeatRuleMatchDescriptors(unitList, 1, 'rule', rule, layerId) ?? []).map((d) => [d.field, d.sourceField])

	const rule: LQY.RepeatRule = { label: 'Unit', field: 'Unit', within: 3 }
	const crossTeamRule: LQY.RepeatRule = { ...rule, crossTeam: true }

	it('reports nothing when only the other team ran the unit', () => {
		expect(fieldsFor(rule, PREVIOUS_UNITS)).toEqual([])
	})

	it('reports both teams under crossTeam when the sides are swapped', () => {
		expect(fieldsFor(crossTeamRule, PREVIOUS_UNITS)).toEqual(['Unit_A', 'Unit_B'])
	})

	it('points each crossTeam descriptor at the source team that actually ran the unit', () => {
		expect(fieldPairsFor(crossTeamRule, PREVIOUS_UNITS)).toEqual([
			['Unit_A', 'Unit_B'],
			['Unit_B', 'Unit_A'],
		])
	})

	it('reports only the repeating team when one side keeps its unit', () => {
		expect(fieldsFor(rule, UNITS_ONE_SIDE)).toEqual(['Unit_A'])
		expect(fieldsFor(crossTeamRule, UNITS_ONE_SIDE)).toEqual(['Unit_A'])
		expect(fieldPairsFor(crossTeamRule, UNITS_ONE_SIDE)).toEqual([['Unit_A', 'Unit_A']])
	})
})

describe('reading a repeat match descriptor from the source item', () => {
	const rule: LQY.RepeatRule = { label: 'Faction', field: 'Faction', within: 3, crossTeam: true }

	it('swaps both ends, so the source highlights the team that played the faction', () => {
		const [descriptor] = getRepeatRuleMatchDescriptors(list, 1, 'rule', rule, SIDES_SWAPPED, 2)!
		expect(LQY.repeatDescriptorFromSourcePerspective(descriptor as LQY.RepeatMatchDescriptor & { itemId: LQY.ItemId })).toEqual({
			...descriptor,
			field: 'Faction_B',
			layerId: PREVIOUS,
			itemId: 1,
			sourceField: 'Faction_A',
			sourceLayerId: SIDES_SWAPPED,
			sourceItemId: 2,
		})
	})
})

// ---------------------------- the lookback window ----------------------------

const HISTORY = [
	'GD-RAAS-V1:USA-CA:RGF-CA',
	'NV-RAAS-V1:USA-CA:RGF-CA',
	'FL-RAAS-V1:USA-CA:RGF-CA',
	'YH-RAAS-V1:USA-CA:RGF-CA',
	'CH-RAAS-V1:USA-CA:RGF-CA',
	'MT-RAAS-V1:USA-CA:RGF-CA',
]
const QUEUED = ['SM-RAAS-V1:USA-CA:RGF-CA', 'TL-RAAS-V1:USA-CA:RGF-CA']

const historyItems = (layerIds: string[]): LQY.LayerItem[] =>
	layerIds.map((layerId, i) => ({ type: 'match-history-entry', itemId: i + 1, layerId }) as LQY.LayerItem)
const queueItems = (layerIds: string[]): LQY.LayerItem[] =>
	layerIds.map((layerId, i) => ({ type: 'single-list-item', itemId: `q${i}`, layerId }) as LQY.LayerItem)
const stateOf = (items: LQY.LayerItem[], firstLayerItemParity = 0): LQY.LayerItemsState => ({ layerItems: items, firstLayerItemParity })

const mapRule: LQY.RepeatRule = { label: 'Map', field: 'Map', within: 4 }

function cursorIndexOf(list: LQY.LayerItemsState, cursor: LL.Cursor) {
	return LQY.resolveCursorIndex(list, LQY.fromLayerListCursor(list, cursor))!.outerIndex
}

function offsetsFor(rule: LQY.RepeatRule, list: LQY.LayerItemsState, cursor: LL.Cursor, layerId: string) {
	const descriptors = getRepeatRuleMatchDescriptors(list, cursorIndexOf(list, cursor), 'rule', rule, layerId) ?? []
	return descriptors.map((d) => d.repeatOffset)
}

const mapsRepeating = (rule: LQY.RepeatRule, list: LQY.LayerItemsState, cursor: LL.Cursor, candidates: string[]) =>
	candidates.filter((id) => offsetsFor(rule, list, cursor, id).length > 0).map((id) => L.toLayer(id).Map)

describe('the window a repeat rule looks back over', () => {
	const list = stateOf(historyItems(HISTORY))

	it('covers exactly `within` items, ending at the item before the cursor', () => {
		for (const within of [1, 2, 3, 4, 5, 6]) {
			const offsets = HISTORY.flatMap((id) => offsetsFor({ ...mapRule, within }, list, { type: 'end' }, id)).sort((a, b) => a - b)
			expect(offsets, `within ${within}`).toEqual(Array.from({ length: within }, (_, i) => i + 1))
		}
	})

	it('excludes everything at a within of 0', () => {
		expect(mapsRepeating({ ...mapRule, within: 0 }, list, { type: 'end' }, HISTORY)).toEqual([])
	})

	it('stops at a seeding match rather than counting past it', () => {
		const withSeed = ['GD-RAAS-V1:USA-CA:RGF-CA', 'NV-RAAS-V1:USA-CA:RGF-CA', 'FL-SD-V1:USA-CA:RGF-CA', 'CH-RAAS-V1:USA-CA:RGF-CA']
		const seedList = stateOf(historyItems(withSeed))
		expect(mapsRepeating(mapRule, seedList, { type: 'end' }, withSeed)).toEqual(['Chora'])
	})
})

describe('where the cursor sits in the queue', () => {
	const list = stateOf([...historyItems(HISTORY), ...queueItems(QUEUED)])
	const all = [...HISTORY, ...QUEUED]

	it('counts the queued items when adding after them', () => {
		expect(mapsRepeating(mapRule, list, { type: 'end' }, all)).toEqual(['Chora', 'Mutaha', 'Sumari', 'Tallil'])
	})

	it('counts only played matches when adding before them', () => {
		expect(mapsRepeating(mapRule, list, { type: 'start' }, all)).toEqual(['Fallujah', 'Yehorivka', 'Chora', 'Mutaha'])
	})

	it('reports a queued repeat at the offset of its queue position', () => {
		// Tallil sits last in the queue, one slot behind a layer added after it
		expect(offsetsFor(mapRule, list, { type: 'end' }, 'TL-RAAS-V1:USA-CA:RGF-CA')).toEqual([1])
	})
})

// The filter hides a row and the indicator marks it. They are computed separately -- one lowers to engine IR, the
// other compares layers in JS -- so a divergence would show a violation the "Hide Repeats" toggle cannot hide.
describe('the Hide Repeats filter and the violation indicator', () => {
	function evalIr(ir: LE.Ir, layerId: string): boolean {
		const layer = L.toLayer(layerId) as Record<string, string | undefined>
		switch (ir.op) {
			case 'true':
				return true
			case 'false':
				return false
			case 'and':
				return ir.children.every((c) => evalIr(c, layerId))
			case 'or':
				return ir.children.some((c) => evalIr(c, layerId))
			case 'not':
				return !evalIr(ir.child, layerId)
			case 'in_vals': {
				const value = layer[COLUMNS[ir.col]]
				if (!value) return false
				const dbValue = LC.dbValue(COLUMNS[ir.col], value, ctx)
				if (dbValue === null || LC.isUnmappedDbValue(dbValue)) return false
				return ir.vals.includes(Number(dbValue))
			}
			default:
				throw new Error(`unhandled ir op ${JSON.stringify(ir)}`)
		}
	}

	function mulberry32(seed: number) {
		return () => {
			seed = (seed + 0x6d2b79f5) | 0
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296
		}
	}

	const LAYER_POOL = (() => {
		const teams = ['USA-CA', 'RGF-CA', 'USA-MT', 'PLA-AR', 'ADF-MZ', 'TLF-AR', 'BAF-CA', 'CAF-CA']
		const pool: string[] = []
		for (const map of ['GD', 'NV', 'FL', 'YH', 'CH', 'MT', 'SM', 'TL', 'AB', 'KD']) {
			for (const gamemode of ['RAAS', 'AAS', 'TC']) {
				for (const version of ['V1', 'V2']) {
					for (let i = 0; i < teams.length; i++) {
						const id = `${map}-${gamemode}-${version}:${teams[i]}:${teams[(i + 1) % teams.length]}`
						if (L.isKnownLayer(id)) pool.push(id)
					}
				}
			}
		}
		return pool
	})()

	const FIELDS: LQY.RepeatRule['field'][] = ['Map', 'Layer', 'Gamemode', 'Size', 'Faction', 'Unit', 'Alliance', 'UnitMatchup']

	it('agree across randomized histories, rules and candidates', () => {
		expect(LAYER_POOL.length).toBeGreaterThan(50)
		const rand = mulberry32(20260803)
		const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]
		const mismatches: string[] = []

		for (let trial = 0; trial < 2000; trial++) {
			const items = [
				...historyItems(Array.from({ length: 1 + Math.floor(rand() * 6) }, () => pick(LAYER_POOL))),
				...queueItems(Array.from({ length: Math.floor(rand() * 4) }, () => pick(LAYER_POOL))),
			]
			const list = stateOf(items, Math.floor(rand() * 2))
			const field = pick(FIELDS)
			const rule: LQY.RepeatRule = {
				label: field,
				field,
				within: 1 + Math.floor(rand() * 8),
				...(rand() < 0.3 ? { crossTeam: true } : {}),
			}
			const where = whereFor(rule, list)
			const cursorIndex = cursorIndexOf(list, { type: 'end' })

			for (let c = 0; c < 3; c++) {
				const candidate = pick(LAYER_POOL)
				const hidden = evalIr(where, candidate)
				const indicated = (getRepeatRuleMatchDescriptors(list, cursorIndex, 'rule', rule, candidate) ?? []).length > 0
				if (hidden !== indicated && mismatches.length < 10) {
					mismatches.push(JSON.stringify({ rule, candidate, hidden, indicated, items: items.map((i) => i.layerId) }))
				}
			}
		}

		expect(mismatches).toEqual([])
	})
})

// ---------------------------- the two paths that resolve a match ----------------------------

// A queued item's violations come from getLayerItemStatuses, which walks the list; a candidate row in the select
// layers dialog comes from queryLayers, which resolves a cursor and post-processes each row. Both end up in
// getRepeatRuleMatchDescriptors, so the risk is the index they hand it.
const SLOT_HISTORY = ['GD-RAAS-V1:USA-CA:RGF-CA', 'NV-RAAS-V1:USA-CA:RGF-CA', 'FL-RAAS-V1:USA-CA:RGF-CA', 'CH-RAAS-V1:USA-CA:RGF-CA']
const SLOT_QUEUE = ['GD-RAAS-V2:RGF-CA:USA-CA', 'NV-AAS-V1:USA-CA:RGF-CA', 'TL-RAAS-V1:USA-CA:RGF-CA']

const slotList = (): LQY.LayerItemsState => ({
	layerItems: [
		...SLOT_HISTORY.map((layerId, i) => ({ type: 'match-history-entry', itemId: i + 1, layerId }) as LQY.LayerItem),
		...SLOT_QUEUE.map((layerId, i) => ({ type: 'single-list-item', itemId: `q${i}`, layerId }) as LQY.LayerItem),
	],
	firstLayerItemParity: 0,
})

const indexFor = (list: LQY.LayerItemsState, cursor: LL.Cursor) =>
	LQY.resolveCursorIndex(list, LQY.fromLayerListCursor(list, cursor))!.outerIndex

describe('the cursor a select layers dialog resolves for a slot', () => {
	const list = slotList()
	const queueItemIds = SLOT_QUEUE.map((_, i) => `q${i}`)

	it('puts play-next at the first queue slot and play-after past the last item', () => {
		expect(indexFor(list, { type: 'start' })).toBe(SLOT_HISTORY.length)
		expect(indexFor(list, { type: 'end' })).toBe(list.layerItems.length)
	})

	it('puts an "on" cursor at the item own index, so editing a layer never compares it against itself', () => {
		queueItemIds.forEach((itemId, i) => {
			expect(indexFor(list, { type: 'item-relative', itemId, position: 'on' })).toBe(SLOT_HISTORY.length + i)
		})
	})

	it('puts "before" at the slot the new layer takes and "after" at the slot past it', () => {
		queueItemIds.forEach((itemId, i) => {
			expect(indexFor(list, { type: 'item-relative', itemId, position: 'before' })).toBe(SLOT_HISTORY.length + i)
			expect(indexFor(list, { type: 'item-relative', itemId, position: 'after' })).toBe(SLOT_HISTORY.length + i + 1)
		})
	})

	// iterItems yields a vote item before its own choices, so the last list item is the vote, not its last choice
	it('puts play-after past a trailing vote item rather than inside it', () => {
		const withVote = slotList()
		withVote.layerItems.push({
			type: 'vote-list-item',
			itemId: 'v0',
			layerId: SLOT_QUEUE[0],
			choices: [
				{ type: 'single-list-item', itemId: 'v0-a', layerId: SLOT_QUEUE[0] },
				{ type: 'single-list-item', itemId: 'v0-b', layerId: SLOT_QUEUE[1] },
			],
		} as unknown as LQY.LayerItem)
		expect(indexFor(withVote, { type: 'end' })).toBe(withVote.layerItems.length)
	})
})

describe('queryLayers and getLayerItemStatuses resolving the same slot', () => {
	const settings = SETTINGS.PublicServerSettingsSchema.parse({})
	const repeatConstraints = SETTINGS.getSettingsConstraints(settings).filter((c) => c.type === 'do-not-repeat')
	const key = (d: LQY.RepeatMatchDescriptor) => `${d.constraintId}|${d.field}|${d.repeatOffset}`

	it('produce the same descriptors for every queued item', async () => {
		const list = slotList()
		const res = await getLayerItemStatuses({ ctx, input: { list, constraints: repeatConstraints } })
		if (res.code !== 'ok') throw new Error('expected getLayerItemStatuses to succeed')

		for (const item of list.layerItems) {
			if (item.type === 'match-history-entry') continue
			const fromStatuses = (res.statuses.matchDescriptors.get(item.itemId) ?? [])
				.filter((d): d is LQY.RepeatMatchDescriptor => d.type === 'repeat-rule')
				.map(key)
				.sort()

			const cursorIndex = indexFor(list, { type: 'item-relative', itemId: item.itemId as string, position: 'on' })
			const fromQuery = repeatConstraints
				.flatMap((c) =>
					c.type === 'do-not-repeat' ? (getRepeatRuleMatchDescriptors(list, cursorIndex, c.id, c.rule, item.layerId) ?? []) : [],
				)
				.map(key)
				.sort()

			expect(fromQuery, item.itemId).toEqual(fromStatuses)
		}
	})
})

describe('the constraints each path builds from the same settings', () => {
	const withWarn = (warn: boolean | undefined) => {
		const settings = SETTINGS.PublicServerSettingsSchema.parse({})
		settings.queue.mainPool.repeatRules = settings.queue.mainPool.repeatRules.map((rule) => ({ ...rule, warn }))
		return settings
	}
	const warnFlags = (constraints: LQY.Constraint[]) =>
		constraints.filter((c) => c.type === 'do-not-repeat').map((c) => `${c.id}:${c.warn}`)

	// the Warn checkbox writes `warn || undefined`, so true and undefined are the only states it can produce
	for (const warn of [true, undefined]) {
		it(`carry the same warn flag with the checkbox ${warn ? 'ticked' : 'unticked'}`, () => {
			const settings = withWarn(warn)
			expect(warnFlags(SETTINGS.getSettingsConstraints(settings))).toEqual(
				warnFlags(PoolCheckboxesPrt.getToggledRepeatRuleConstraints(settings, 'disabled')),
			)
		})
	}
})

// ---------------------------- applying the rules as a filter ----------------------------

// Hide Repeats applies every rule inverted; ctrl+clicking it applies them regularly to show only the layers it
// would have hidden. The two must describe the same set, which they only do if the rules are one disjunction:
// anding them regularly asks for a layer that repeats every rule at once.
describe('the Hide Repeats filter', () => {
	const filterSettings = SETTINGS.PublicServerSettingsSchema.parse({})
	const filterList: LQY.LayerItemsState = {
		layerItems: [{ type: 'match-history-entry', itemId: 1, layerId: 'GD-RAAS-V1:USA-CA:RGF-CA' }] as LQY.LayerItem[],
		firstLayerItemParity: 0,
	}

	const CANDIDATES = {
		// same map, different gamemode and factions
		mapOnly: 'GD-AAS-V1:ADF-CA:PLA-CA',
		// the same layer with the faction slots swapped, which at the next parity puts each faction back on its own side
		everyRule: 'GD-RAAS-V1:RGF-CA:USA-CA',
		unrelated: 'NV-AAS-V2:ADF-CA:PLA-CA',
	}

	const whereForApplyAs = (applyAs: SETTINGS.PoolFilterApplyAs) => {
		const compiled = buildQueryConstraints(ctx, {
			constraints: PoolCheckboxesPrt.getToggledRepeatRuleConstraints(filterSettings, applyAs),
			list: filterList,
			cursor: { type: 'end' },
		})
		if (compiled.code !== 'ok') throw new Error('expected the constraints to compile')
		return compiled.where
	}

	function matches(where: LE.Ir, layerId: string): boolean {
		const layer = L.toLayer(layerId) as Record<string, string | undefined>
		switch (where.op) {
			case 'true':
				return true
			case 'false':
				return false
			case 'and':
				return where.children.every((c) => matches(c, layerId))
			case 'or':
				return where.children.some((c) => matches(c, layerId))
			case 'not':
				return !matches(where.child, layerId)
			case 'in_vals': {
				const value = layer[COLUMNS[where.col]]
				if (!value) return false
				const dbValue = LC.dbValue(COLUMNS[where.col], value, ctx)
				if (dbValue === null || LC.isUnmappedDbValue(dbValue)) return false
				return where.vals.includes(Number(dbValue))
			}
			default:
				throw new Error(`unhandled ir op ${JSON.stringify(where)}`)
		}
	}

	it('hides a layer that repeats a single rule', () => {
		const where = whereForApplyAs('inverted')
		expect(matches(where, CANDIDATES.mapOnly)).toBe(false)
		expect(matches(where, CANDIDATES.everyRule)).toBe(false)
		expect(matches(where, CANDIDATES.unrelated)).toBe(true)
	})

	it('shows exactly what it hides when inverted, including a layer repeating one rule alone', () => {
		const hide = whereForApplyAs('inverted')
		const showOnly = whereForApplyAs('regular')
		for (const [name, layerId] of Object.entries(CANDIDATES)) {
			expect(matches(showOnly, layerId), name).toBe(!matches(hide, layerId))
		}
	})
})
