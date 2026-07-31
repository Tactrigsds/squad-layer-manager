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

const COLUMNS = Object.keys(LC.BASE_COLUMN_CONFIG.defs)

const ctx = {
	...CS.init(),
	effectiveColsConfig: LC.BASE_COLUMN_CONFIG,
	filters: new Map(),
	engine: { columnIndex: (name: string) => COLUMNS.indexOf(name) },
} as unknown as QueryCtx

const col = (name: string) => COLUMNS.indexOf(name)
const faction = (value: string) => Number(LC.dbValue('Faction_1', value, ctx))

// one played match, so the cursor sits at index 1 and the target match has the opposite team parity: its team A is
// the Faction_2 slot
const list: LQY.LayerItemsState = {
	layerItems: [{ type: 'match-history-entry', itemId: 1, layerId: PREVIOUS }],
	firstLayerItemParity: 0,
}

function whereFor(rule: LQY.RepeatRule) {
	const compiled = buildQueryConstraints(ctx, {
		constraints: [CB.repeatRule('faction-rule', rule, { filterApplState: 'regular' })],
		list,
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
		const pooled = [faction('USA'), faction('RGF')].sort((a, b) => a - b)
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

describe('the match descriptors a Faction repeat rule produces', () => {
	const fieldsFor = (rule: LQY.RepeatRule, layerId: string) =>
		(getRepeatRuleMatchDescriptors(list, 1, 'faction-rule', rule, layerId) ?? []).map((d) => d.field)

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
