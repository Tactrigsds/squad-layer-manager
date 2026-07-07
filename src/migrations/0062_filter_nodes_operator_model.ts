import type { MigrationDriver } from '@/server/migrate'

// Rewrites persisted filter entities (filters.filter JSON) from the old "comparison nested in node"
// shape to the operator-primary node model. All shapes are inlined per the frozen-in-time rule; this
// migration must never import from the live app.
//
// Old node shape:
//   { type: 'and'|'or', neg, children }
//   { type: 'comp', neg, comp: { code, column, value?, values?, range? } }
//   { type: 'apply-filter', neg, filterId }
//   { type: 'allow-matchups', neg, allowMatchups: { mode?, allMasks: FactionMask[][] } }
//     FactionMask = { alliance?: string[], faction?: string[], unit?: string[] }
//
// New node shape:
//   { type: 'and'|'or', neg, children }
//   { type: 'eq'|'lt'|'gt', neg, args: [ScalarArg, ScalarArg] }
//   { type: 'in', neg, args: [ScalarArg, ValuesArg] }
//   { type: 'inrange', neg, args: [ScalarArg, ScalarArg, ScalarArg] }
//   { type: 'apply-filter', neg, filterId }
//   ScalarArg = {type:'column',column} | {type:'value',value}
//   ValuesArg = {type:'values', values}
// allow-matchups expands to and/or over concrete _1/_2 columns, which preserves same-team correlation.

type NewNode = any

const NEW_TYPES = new Set(['and', 'or', 'eq', 'in', 'lt', 'gt', 'inrange', 'apply-filter'])

const alwaysTrue = (): NewNode => ({ type: 'and', neg: false, children: [] })

function colArg(column: string) {
	return { type: 'column' as const, column }
}
function valArg(value: unknown) {
	return { type: 'value' as const, value: value ?? null }
}

// upgrades a legacy comparison to { type, neg, args }; `neg` here is the operator's built-in polarity
function upgradeComparison(comp: any): { type: string; neg: boolean; args: any[] } {
	const column = comp.column
	const anchor = colArg(column)
	switch (comp.code) {
		case 'eq':
			return { type: 'eq', neg: false, args: [anchor, valArg(comp.value)] }
		case 'neq':
			return { type: 'eq', neg: true, args: [anchor, valArg(comp.value)] }
		case 'in':
			return { type: 'in', neg: false, args: [anchor, { type: 'values', values: comp.values ?? [] }] }
		case 'notin':
			return { type: 'in', neg: true, args: [anchor, { type: 'values', values: comp.values ?? [] }] }
		case 'lt':
			return { type: 'lt', neg: false, args: [anchor, valArg(comp.value)] }
		case 'gt':
			return { type: 'gt', neg: false, args: [anchor, valArg(comp.value)] }
		case 'inrange': {
			const lo = comp.range?.[0]
			const hi = comp.range?.[1]
			if (lo !== undefined && lo !== null && hi !== undefined && hi !== null) {
				return { type: 'inrange', neg: false, args: [anchor, valArg(lo), valArg(hi)] }
			}
			// one-sided legacy ranges become negated open comparisons: [lo, ..] => NOT (col < lo) => col >= lo
			if (lo !== undefined && lo !== null) return { type: 'lt', neg: true, args: [anchor, valArg(lo)] }
			if (hi !== undefined && hi !== null) return { type: 'gt', neg: true, args: [anchor, valArg(hi)] }
			// degenerate empty range: never valid, keep something inspectable
			return { type: 'inrange', neg: false, args: [anchor, valArg(0), valArg(0)] }
		}
		case 'isnull':
			return { type: 'eq', neg: false, args: [anchor, valArg(null)] }
		case 'notnull':
			return { type: 'eq', neg: true, args: [anchor, valArg(null)] }
		case 'is-true':
			return { type: 'eq', neg: false, args: [anchor, valArg(true)] }
		default:
			throw new Error(`unknown legacy comparison code: ${comp.code}`)
	}
}

function concreteColArg(column: string) {
	return { type: 'column' as const, column }
}

function inOrEqConcrete(concreteColumn: string, values: string[]): NewNode {
	if (values.length === 1) return { type: 'eq', neg: false, args: [concreteColArg(concreteColumn), valArg(values[0])] }
	return { type: 'in', neg: false, args: [concreteColArg(concreteColumn), { type: 'values', values }] }
}

// a single mask against one team's concrete columns (Faction_1, Unit_1, ...): AND of present fields.
// keeps same-team correlation without any team-scope block.
function maskConcrete(mask: any, team: 1 | 2): NewNode {
	const children: NewNode[] = []
	if (mask.alliance && mask.alliance.length > 0) children.push(inOrEqConcrete(`Alliance_${team}`, mask.alliance))
	if (mask.faction && mask.faction.length > 0) children.push(inOrEqConcrete(`Faction_${team}`, mask.faction))
	if (mask.unit && mask.unit.length > 0) children.push(inOrEqConcrete(`Unit_${team}`, mask.unit))
	if (children.length === 0) return alwaysTrue()
	if (children.length === 1) return children[0]
	return { type: 'and', neg: false, children }
}

function orOf(nodes: NewNode[]): NewNode {
	if (nodes.length === 0) return alwaysTrue()
	if (nodes.length === 1) return nodes[0]
	return { type: 'or', neg: false, children: nodes }
}

function andOf(nodes: NewNode[]): NewNode {
	if (nodes.length === 0) return alwaysTrue()
	if (nodes.length === 1) return nodes[0]
	return { type: 'and', neg: false, children: nodes }
}

function upgradeAllowMatchups(config: any, neg: boolean): NewNode {
	const mode: string = config.mode ?? 'either'
	const masks0: any[] = config.allMasks?.[0] ?? []
	const masks1: any[] = config.allMasks?.[1] ?? []
	let node: NewNode
	switch (mode) {
		case 'either': {
			// ∃ team t, ∃ configured mask: mask holds for team t
			node = masks0.length === 0 ? alwaysTrue() : orOf(masks0.flatMap((m) => [maskConcrete(m, 1), maskConcrete(m, 2)]))
			break
		}
		case 'both': {
			// ∃ configured mask that holds for *both* teams
			node = masks0.length === 0 ? alwaysTrue() : orOf(masks0.map((m) => andOf([maskConcrete(m, 1), maskConcrete(m, 2)])))
			break
		}
		case 'split': {
			// one side's masks hold for one team while the other side's hold for the other, in either assignment
			if (masks0.length === 0 || masks1.length === 0) {
				node = alwaysTrue()
			} else {
				const side0For = (team: 1 | 2) => orOf(masks0.map((m) => maskConcrete(m, team)))
				const side1For = (team: 1 | 2) => orOf(masks1.map((m) => maskConcrete(m, team)))
				node = {
					type: 'or',
					neg: false,
					children: [
						andOf([side0For(1), side1For(2)]),
						andOf([side0For(2), side1For(1)]),
					],
				}
			}
			break
		}
		default:
			throw new Error(`unknown allow-matchups mode: ${mode}`)
	}
	if (neg) node = { ...node, neg: !node.neg }
	return node
}

function upgradeNode(node: any): NewNode {
	if (node && typeof node === 'object' && NEW_TYPES.has(node.type) && (node.args || node.children || node.type === 'apply-filter')) {
		// already new-shaped (defensive) — recurse into children only
		if (node.children) return { ...node, children: node.children.map(upgradeNode) }
		return node
	}
	const neg: boolean = node.neg ?? false
	switch (node.type) {
		case 'and':
		case 'or':
			return { type: node.type, neg, children: (node.children ?? []).map(upgradeNode) }
		case 'comp': {
			const upgraded = upgradeComparison(node.comp)
			// legacy node-level neg composes with the comparison's built-in polarity
			return { ...upgraded, neg: neg !== upgraded.neg }
		}
		case 'apply-filter':
			return { type: 'apply-filter', neg, filterId: node.filterId }
		case 'allow-matchups':
			return upgradeAllowMatchups(node.allowMatchups ?? {}, neg)
		default:
			throw new Error(`unknown legacy node type: ${node.type}`)
	}
}

function assertUpgraded(node: any, filterId: string): void {
	if (!node || typeof node !== 'object' || !NEW_TYPES.has(node.type)) {
		throw new Error(`filter ${filterId}: produced invalid node type ${node?.type}`)
	}
	if (node.children) { for (const child of node.children) assertUpgraded(child, filterId) }
}

export async function up(db: MigrationDriver): Promise<void> {
	const rows = db.prepare(`SELECT id, filter FROM filters`).all() as { id: string; filter: string }[]
	const update = db.prepare(`UPDATE filters SET filter = ? WHERE id = ?`)
	for (const row of rows) {
		const parsed = JSON.parse(row.filter)
		const upgraded = upgradeNode(parsed)
		assertUpgraded(upgraded, row.id)
		update.run(JSON.stringify(upgraded), row.id)
	}
}
