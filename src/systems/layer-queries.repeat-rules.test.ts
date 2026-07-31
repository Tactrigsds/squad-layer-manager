import { describe, expect, it } from 'vitest'

import * as CB from '@/models/constraint-builders'
import * as CS from '@/models/context-shared'
import * as LC from '@/models/layer-columns'
import type * as LE from '@/models/layer-engine'
import type * as LQY from '@/models/layer-queries.models'
import { buildQueryConstraints, getRepeatRuleMatchDescriptors, type QueryCtx } from '@/systems/layer-queries.shared'

// Team A of the previous match played USA, team B played RGF.
const PREVIOUS = 'GD-RAAS-V1:USA-CA:RGF-CA'
// teams alternate slots, so at the cursor these read team A = RGF, team B = USA: the same two factions, sides swapped
const SIDES_SWAPPED = 'NV-RAAS-V1:USA-CA:RGF-CA'
const SAME_SIDES = 'NV-RAAS-V1:RGF-CA:USA-CA'

// Team A of the previous match ran Mechanized, team B ran AirAssault. Queueing this same layer again swaps which
// team holds which unit, because the parity flips: at the cursor team A runs AirAssault and team B Mechanized.
const PREVIOUS_UNITS = 'HJ-RAAS-V1:RGF-MZ:PLA-AA'
// team A = Mechanized, matching the previous team A; team B = Armored, matching nothing
const UNITS_ONE_SIDE = 'FL-RAAS-V2:TLF-AR:ADF-MZ'

const COLUMNS = Object.keys(LC.BASE_COLUMN_CONFIG.defs)

const ctx = {
	...CS.init(),
	effectiveColsConfig: LC.BASE_COLUMN_CONFIG,
	filters: new Map(),
	engine: { columnIndex: (name: string) => COLUMNS.indexOf(name) },
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

describe('the match descriptors a Faction repeat rule produces', () => {
	const fieldsFor = (rule: LQY.RepeatRule, layerId: string) =>
		(getRepeatRuleMatchDescriptors(list, 1, 'rule', rule, layerId) ?? []).map((d) => d.field)

	const rule: LQY.RepeatRule = { label: 'Faction', field: 'Faction', within: 3 }
	const crossTeamRule: LQY.RepeatRule = { ...rule, crossTeam: true }

	it('reports nothing when only the other team played the faction', () => {
		expect(fieldsFor(rule, SIDES_SWAPPED)).toEqual([])
	})

	it('reports both teams under crossTeam when the sides are swapped', () => {
		expect(fieldsFor(crossTeamRule, SIDES_SWAPPED)).toEqual(['Faction_A', 'Faction_B'])
	})

	it('reports one descriptor per team when both teams repeat their own faction', () => {
		expect(fieldsFor(rule, SAME_SIDES)).toEqual(['Faction_A', 'Faction_B'])
		expect(fieldsFor(crossTeamRule, SAME_SIDES)).toEqual(['Faction_A', 'Faction_B'])
	})
})

describe('the match descriptors a Unit repeat rule produces', () => {
	const fieldsFor = (rule: LQY.RepeatRule, layerId: string) =>
		(getRepeatRuleMatchDescriptors(unitList, 1, 'rule', rule, layerId) ?? []).map((d) => d.field)

	const rule: LQY.RepeatRule = { label: 'Unit', field: 'Unit', within: 3 }
	const crossTeamRule: LQY.RepeatRule = { ...rule, crossTeam: true }

	it('reports nothing when only the other team ran the unit', () => {
		expect(fieldsFor(rule, PREVIOUS_UNITS)).toEqual([])
	})

	it('reports both teams under crossTeam when the sides are swapped', () => {
		expect(fieldsFor(crossTeamRule, PREVIOUS_UNITS)).toEqual(['Unit_A', 'Unit_B'])
	})

	it('reports only the repeating team when one side keeps its unit', () => {
		expect(fieldsFor(rule, UNITS_ONE_SIDE)).toEqual(['Unit_A'])
		expect(fieldsFor(crossTeamRule, UNITS_ONE_SIDE)).toEqual(['Unit_A'])
	})
})
