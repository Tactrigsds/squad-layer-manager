import { up as migrateFilterNodes } from '@/migrations/0062_filter_nodes_operator_model'
import { up as migrateTeamScopes } from '@/migrations/0063_filter_team_scopes_to_and_or'
import { up as migrateBlockOperators } from '@/migrations/0065_filter_block_operators'
import { up as migrateApplyOperators } from '@/migrations/0066_filter_apply_operators'
import * as CS from '@/models/context-shared'
import * as FB from '@/models/filter-builders'
import * as F from '@/models/filter.models'
import * as LC from '@/models/layer-columns'
import * as LE from '@/models/layer-engine'
import DatabaseConstructor from 'better-sqlite3'
import { describe, expect, it } from 'vitest'

// -------- operator selection round-trips --------

describe('operator selection', () => {
	it('round-trips selection key <-> node for every option in an enum domain', () => {
		const domain = F.columnValueDomain('Map')!
		for (const option of F.compOpSelectOptions(domain)) {
			const node = F.applyCompOpSelection({ type: 'eq', neg: false, args: [{ type: 'column', column: 'Map' }] }, option)
			expect(F.compOpSelectionKey(node)).toBe(option.key)
		}
	})

	it('boolean domain omits ordered and list operators (and has no dedicated null tests)', () => {
		const keys = F.compOpSelectOptions({ kind: 'boolean' }).map((o) => o.key)
		expect(keys).toEqual(['eq', 'neq'])
	})

	it('no operator set includes dedicated isnull/notnull operators', () => {
		for (
			const domain of [undefined, { kind: 'boolean' as const }, { kind: 'number' as const, integral: false }, {
				kind: 'enum' as const,
				mapping: 'factions',
			}]
		) {
			const keys = F.compOpSelectOptions(domain).map((o) => o.key)
			expect(keys).not.toContain('isnull')
			expect(keys).not.toContain('notnull')
		}
	})

	it('float domain keeps eq/neq (for null tests) and ordering, but not in', () => {
		const keys = F.compOpSelectOptions({ kind: 'number', integral: false }).map((o) => o.key)
		for (const k of ['eq', 'neq', 'lt', 'gt', 'inrange']) expect(keys).toContain(k)
		for (const k of ['in', 'notin']) expect(keys).not.toContain(k)
		expect(F.isFloatEqNullOnly({ kind: 'number', integral: false }, 'eq')).toBe(true)
		expect(F.isFloatEqNullOnly({ kind: 'number', integral: true }, 'eq')).toBe(false)
	})

	it('integer domain keeps exact-equality operators', () => {
		const keys = F.compOpSelectOptions({ kind: 'number', integral: true }).map((o) => o.key)
		for (const k of ['eq', 'neq', 'in', 'lt', 'inrange']) expect(keys).toContain(k)
	})

	it('a null-valued eq round-trips to the eq/neq keys (not a dedicated null op)', () => {
		const eqNull: F.EditableCompNode = {
			type: 'eq',
			neg: false,
			args: [{ type: 'column', column: 'LayerVersion' }, { type: 'value', value: null }],
		}
		expect(F.compOpSelectionKey(eqNull)).toBe('eq')
		expect(F.compOpSelectionKey({ ...eqNull, neg: true })).toBe('neq')
	})

	it('treats integer and float domains as mutually comparable', () => {
		expect(F.domainsCompatible({ kind: 'number', integral: true }, { kind: 'number', integral: false })).toBe(true)
	})

	it('defaults float subjects to inrange, others to eq', () => {
		expect(F.defaultCompType({ kind: 'number', integral: false })).toBe('inrange')
		expect(F.defaultCompType({ kind: 'number', integral: true })).toBe('eq')
		expect(F.defaultCompType({ kind: 'enum', mapping: 'factions' })).toBe('eq')
	})

	it('carries a single value across an eq -> in change', () => {
		const eq: F.EditableCompNode = { type: 'eq', neg: false, args: [{ type: 'column', column: 'Map' }, { type: 'value', value: 'Narva' }] }
		const asIn = F.applyCompOpSelection(eq, { key: 'in', label: 'in', type: 'in', neg: false })
		expect(asIn.args[1]).toEqual({ type: 'values', values: ['Narva'] })
	})
})

describe('value domains', () => {
	it('treats different enum mappings as incompatible', () => {
		expect(F.domainsCompatible(F.columnValueDomain('Faction_1')!, F.columnValueDomain('Faction_2')!)).toBe(true)
		expect(F.domainsCompatible(F.columnValueDomain('Faction_1')!, F.columnValueDomain('Unit_1')!)).toBe(false)
	})
})

// -------- compiler validation --------

function testCtx(): LE.LowerCtx {
	return {
		...CS.init(),
		effectiveColsConfig: LC.BASE_COLUMN_CONFIG,
		filters: new Map(),
		// the engine addresses columns by index; lowering only needs a stable mapping, not a loaded artifact
		colIndex: (name: string) => LC.COLUMN_KEYS.indexOf(name as never),
	}
}

describe('filter lowering validation', () => {
	// team-column tests use IS NULL tests (eq against null) so they don't depend on enum value mappings
	it('accepts a simple column comparison', () => {
		expect(LE.lowerFilterNode(testCtx(), FB.isNull('Map')).code).toBe('ok')
	})

	it('accepts column vs column of the same domain', () => {
		const res = LE.lowerFilterNode(testCtx(), FB.eq(FB.col('Faction_1'), FB.col('Faction_2')))
		expect(res.code).toBe('ok')
	})

	it('rejects column vs column of different domains', () => {
		const res = LE.lowerFilterNode(testCtx(), FB.eq(FB.col('Faction_1'), FB.col('Unit_1')))
		expect(res.code).toBe('err:invalid-node')
	})

	it('accepts a team-column comparison (expands over both teams) for either and both quantifiers', () => {
		expect(LE.lowerFilterNode(testCtx(), FB.isNull(FB.teamCol('Faction', 'either'))).code).toBe('ok')
		expect(LE.lowerFilterNode(testCtx(), FB.isNull(FB.teamCol('Alliance', 'both'))).code).toBe('ok')
	})

	it('reports an unmapped column', () => {
		const res = LE.lowerFilterNode(testCtx(), FB.isNull('NotAColumn'))
		expect(res.code).toBe('err:invalid-node')
		if (res.code === 'err:invalid-node') {
			expect(res.errors.some((e: F.NodeValidationError) => e.type === 'unmapped-column')).toBe(true)
		}
	})

	// an unmapped column with a non-null value operand must not crash (value conversion goes through
	// LC.dbValue, which throws on an unknown column)
	it('reports (does not throw on) an unmapped column with a value operand, across operators', () => {
		for (
			const node of [FB.eq('NotAColumn', 'x'), FB.inValues('NotAColumn', ['a']), FB.lt('NotAColumn', 5), FB.inrange('NotAColumn', 1, 9)]
		) {
			const res = LE.lowerFilterNode(testCtx(), node)
			expect(res.code).toBe('err:invalid-node')
		}
	})

	it('does not duplicate validation errors for team-column comparisons', () => {
		// 'NotAFaction' is unmapped for both Faction_1 and Faction_2; only one error should surface
		const res = LE.lowerFilterNode(testCtx(), FB.eq(FB.teamCol('Faction', 'either'), 'NotAFaction'))
		expect(res.code).toBe('err:invalid-node')
		if (res.code === 'err:invalid-node') {
			expect(res.errors.filter((e) => e.type === 'unmapped-value')).toHaveLength(1)
		}
	})

	it('accepts an `in` list containing a same-domain column reference', () => {
		const node = {
			type: 'in',
			neg: false,
			args: [{ type: 'column', column: 'Faction_1' }, { type: 'values', values: [{ type: 'column', column: 'Faction_2' }] }],
		} as any
		expect(F.FilterNodeSchema.safeParse(node).success).toBe(true)
		expect(LE.lowerFilterNode(testCtx(), node).code).toBe('ok')
	})

	it('rejects an `in` list column of a different domain', () => {
		const node = {
			type: 'in',
			neg: false,
			args: [{ type: 'column', column: 'Faction_1' }, { type: 'values', values: [{ type: 'column', column: 'Unit_1' }] }],
		} as any
		expect(LE.lowerFilterNode(testCtx(), node).code).toBe('err:invalid-node')
	})

	// the subject (arg[0]) must be a column: value-first / all-constant comparisons are unrepresentable in
	// the builder, so they're rejected structurally and reported by the compiler
	it('rejects a comparison whose subject is a constant', () => {
		const twoConstants = { type: 'eq', neg: false, args: [{ type: 'value', value: 5 }, { type: 'value', value: 6 }] } as any
		const valueFirst = { type: 'eq', neg: false, args: [{ type: 'value', value: 5 }, { type: 'column', column: 'Faction_1' }] } as any
		for (const node of [twoConstants, valueFirst]) {
			expect(F.FilterNodeSchema.safeParse(node).success).toBe(false)
			expect(F.isValidCompNode(node)).toBe(false)
			expect(LE.lowerFilterNode(testCtx(), node).code).toBe('err:invalid-node')
		}
	})

	// the four block operators fold the old (and/or) x negation matrix: all=AND, some=OR, none=NOT OR,
	// notall=NOT AND. verify each lowers to the expected boolean structure.
	it('lowers block operators to the right and/or/not structure', () => {
		const kids = [FB.isNull('Map'), FB.isNull('Gamemode')]
		const irFor = (node: F.FilterNode) => {
			const res = LE.lowerFilterNode(testCtx(), node)
			expect(res.code).toBe('ok')
			return res.code === 'ok' ? res.ir : null
		}
		expect(irFor(FB.all(kids))).toMatchObject({ op: 'and' })
		expect(irFor(FB.some(kids))).toMatchObject({ op: 'or' })
		expect(irFor(FB.none(kids))).toMatchObject({ op: 'not', child: { op: 'or' } })
		expect(irFor(FB.notAll(kids))).toMatchObject({ op: 'not', child: { op: 'and' } })
	})

	// apply-filter folds its old `neg` into the operator: included-in inlines the referenced filter's condition
	// directly, excluded-from wraps it in NOT.
	it('lowers apply-filter operators with the right negation', () => {
		const ctx = testCtx()
		ctx.filters.set('ref', { id: 'ref', filter: FB.isNull('Map') } as any)
		const irFor = (node: F.FilterNode) => {
			const res = LE.lowerFilterNode(ctx, node)
			expect(res.code).toBe('ok')
			return res.code === 'ok' ? res.ir : null
		}
		expect(irFor(FB.includedIn('ref'))).toMatchObject({ op: 'is_null' })
		expect(irFor(FB.excludedFrom('ref'))).toMatchObject({ op: 'not', child: { op: 'is_null' } })
	})

	// LayerVersion's enum mapping includes null ("no version"), stored as the enum index (4), not as SQL NULL
	it('eq against null on an enum column that maps null resolves to the enum index, not a null test', () => {
		const res = LE.lowerFilterNode(testCtx(), FB.eq('LayerVersion', null))
		expect(res.code).toBe('ok')
		if (res.code === 'ok') {
			expect(res.ir).toMatchObject({ op: 'eq_val', val: 4 }) // versions.indexOf(null)
		}
	})

	it('null in an `in` list on such a column becomes the enum index too', () => {
		const node = { type: 'in', neg: false, args: [{ type: 'column', column: 'LayerVersion' }, { type: 'values', values: [null] }] } as any
		const res = LE.lowerFilterNode(testCtx(), node)
		expect(res.code).toBe('ok')
		if (res.code === 'ok') {
			expect(res.ir).toMatchObject({ op: 'in_vals', vals: [4] })
		}
	})
})

// -------- migration --------

async function runMigrations(filter: unknown, ups: ((db: any) => Promise<void>)[]): Promise<any> {
	const db = new DatabaseConstructor(':memory:')
	db.exec(`CREATE TABLE filters (id TEXT PRIMARY KEY, filter TEXT NOT NULL)`)
	db.prepare(`INSERT INTO filters (id, filter) VALUES (?, ?)`).run('f1', JSON.stringify(filter))
	for (const up of ups) await up(db as any)
	const row = db.prepare(`SELECT filter FROM filters WHERE id = ?`).get('f1') as { filter: string }
	db.close()
	return JSON.parse(row.filter)
}

// legacy filter through 0062 then the operator-folding migrations (0065 blocks, 0066 apply-filter),
// yielding the current shape
function migrateOne(legacyFilter: unknown): Promise<any> {
	return runMigrations(legacyFilter, [migrateFilterNodes, migrateBlockOperators, migrateApplyOperators])
}
// intermediate scope-block filter through 0063 then the operator-folding migrations, yielding the current shape
function migrateScopes(scopeFilter: unknown): Promise<any> {
	return runMigrations(scopeFilter, [migrateTeamScopes, migrateBlockOperators, migrateApplyOperators])
}

describe('migration 0062 (legacy filter -> operator model)', () => {
	it('maps comparison codes onto operator nodes', async () => {
		const legacy = {
			type: 'and',
			neg: false,
			children: [
				{ type: 'comp', neg: false, comp: { code: 'eq', column: 'Map', value: 'Narva' } },
				{ type: 'comp', neg: false, comp: { code: 'neq', column: 'Gamemode', value: 'RAAS' } },
				{ type: 'comp', neg: false, comp: { code: 'in', column: 'Faction_1', values: ['USA', 'RGF'] } },
				{ type: 'comp', neg: false, comp: { code: 'notin', column: 'Faction_2', values: ['USA'] } },
				{ type: 'comp', neg: false, comp: { code: 'isnull', column: 'LayerVersion' } },
				{ type: 'comp', neg: false, comp: { code: 'notnull', column: 'LayerVersion' } },
			],
		}
		const migrated = await migrateOne(legacy)
		expect(F.RootFilterNodeSchema.safeParse(migrated).success).toBe(true)
		expect(migrated.children[0]).toEqual({
			type: 'eq',
			neg: false,
			args: [{ type: 'column', column: 'Map' }, { type: 'value', value: 'Narva' }],
		})
		expect(migrated.children[1].type).toBe('eq')
		expect(migrated.children[1].neg).toBe(true)
		expect(migrated.children[2].type).toBe('in')
		expect(migrated.children[3]).toMatchObject({ type: 'in', neg: true })
		expect(migrated.children[4]).toEqual({
			type: 'eq',
			neg: false,
			args: [{ type: 'column', column: 'LayerVersion' }, { type: 'value', value: null }],
		})
		expect(migrated.children[5]).toMatchObject({ type: 'eq', neg: true })
	})

	it('composes node-level neg with the comparison polarity (double negative cancels)', async () => {
		const legacy = { type: 'or', neg: false, children: [{ type: 'comp', neg: true, comp: { code: 'neq', column: 'Map', value: 'Narva' } }] }
		const migrated = await migrateOne(legacy)
		// neq (built-in neg) with node.neg => eq
		expect(migrated.children[0]).toMatchObject({ type: 'eq', neg: false })
	})

	it('maps one-sided legacy ranges to negated open comparisons', async () => {
		const lower = await migrateOne({
			type: 'and',
			neg: false,
			children: [{ type: 'comp', neg: false, comp: { code: 'inrange', column: 'Anvil_Score', range: [5, undefined] } }],
		})
		expect(lower.children[0]).toMatchObject({ type: 'lt', neg: true }) // col >= 5
		const both = await migrateOne({
			type: 'and',
			neg: false,
			children: [{ type: 'comp', neg: false, comp: { code: 'inrange', column: 'Anvil_Score', range: [1, 9] } }],
		})
		expect(both.children[0]).toMatchObject({ type: 'inrange', neg: false })
	})

	it('rewrites allow-matchups (either) into an OR over concrete per-team columns', async () => {
		const legacy = {
			type: 'allow-matchups',
			neg: false,
			allowMatchups: { mode: 'either', allMasks: [[{ faction: ['USA'], unit: ['Armored'] }]] },
		}
		const migrated = await migrateOne(legacy)
		expect(F.FilterNodeSchema.safeParse(migrated).success).toBe(true)
		// single 2-field mask, either => OR of [ and(F1,U1), and(F2,U2) ] over concrete columns
		expect(migrated.type).toBe('some')
		expect(migrated.children).toHaveLength(2)
		expect(migrated.children[0].type).toBe('all')
		const cols = migrated.children[0].children.map((c: any) => c.args[0].column).sort()
		expect(cols).toEqual(['Faction_1', 'Unit_1'])
	})

	it('rewrites allow-matchups (both) and (split) with same-team correlation preserved', async () => {
		// both, single single-field mask => and(F1, F2)
		const both = await migrateOne({
			type: 'allow-matchups',
			neg: false,
			allowMatchups: { mode: 'both', allMasks: [[{ faction: ['USA'] }]] },
		})
		expect(both.type).toBe('all')
		expect(both.children.map((c: any) => c.args[0].column).sort()).toEqual(['Faction_1', 'Faction_2'])
		// split => "some" (OR) of the two team assignments
		const split = await migrateOne({
			type: 'allow-matchups',
			neg: false,
			allowMatchups: { mode: 'split', allMasks: [[{ faction: ['USA'] }], [{ faction: ['RGF'] }]] },
		})
		expect(split.type).toBe('some')
		expect(split.children).toHaveLength(2)
		expect(F.FilterNodeSchema.safeParse(split).success).toBe(true)
	})

	it('produces schema-valid nodes for every rewritten allow-matchups mode', async () => {
		for (const mode of ['either', 'both', 'split'] as const) {
			const migrated = await migrateOne({
				type: 'allow-matchups',
				neg: false,
				allowMatchups: { mode, allMasks: [[{ alliance: ['WPMC'], faction: ['USA'] }], [{ faction: ['RGF'] }]] },
			})
			expect(F.FilterNodeSchema.safeParse(migrated).success).toBe(true)
		}
	})
})

// migration 0063 rescues DBs that ran an earlier revision of 0062 (which emitted team-scope blocks)
describe('migration 0063 (team scopes -> some/all over concrete columns)', () => {
	const teamCol = (column: string) => ({ type: 'team-column', column })
	const eqTeam = (column: string, value: string) => ({ type: 'eq', neg: false, args: [teamCol(column), { type: 'value', value }] })

	it('expands some-team into an OR over concrete _1/_2 columns', async () => {
		const scoped = { type: 'and', neg: false, children: [{ type: 'some-team', neg: false, children: [eqTeam('Unit', 'Armored')] }] }
		const out = await migrateScopes(scoped)
		expect(F.RootFilterNodeSchema.safeParse(out).success).toBe(true)
		expect(out.children[0]).toEqual({
			type: 'some',
			children: [
				{ type: 'eq', neg: false, args: [{ type: 'column', column: 'Unit_1' }, { type: 'value', value: 'Armored' }] },
				{ type: 'eq', neg: false, args: [{ type: 'column', column: 'Unit_2' }, { type: 'value', value: 'Armored' }] },
			],
		})
	})

	it('expands every-team into an AND and teams-split into the two team assignments', async () => {
		const every = await migrateScopes({ type: 'every-team', neg: false, children: [eqTeam('Faction', 'USA')] })
		expect(every.type).toBe('all')
		expect(every.children.map((c: any) => c.args[0].column).sort()).toEqual(['Faction_1', 'Faction_2'])

		const split = await migrateScopes({ type: 'teams-split', neg: false, children: [eqTeam('Faction', 'USA'), eqTeam('Faction', 'RGF')] })
		expect(split.type).toBe('some')
		expect(F.FilterNodeSchema.safeParse(split).success).toBe(true)
	})

	it('leaves already-final filters unchanged (no scope blocks present)', async () => {
		const final = {
			type: 'all',
			children: [{ type: 'eq', neg: false, args: [{ type: 'column', column: 'Map' }, { type: 'value', value: 'Narva' }] }],
		}
		const out = await migrateScopes(final)
		expect(out).toEqual(final)
	})
})
