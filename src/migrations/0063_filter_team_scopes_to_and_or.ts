import type { MigrationDriver } from '@/server/migrate'

// Fixup migration. An earlier revision of 0062 rewrote allow-matchups into team-scope block nodes
// ('some-team' / 'every-team' / 'teams-split') that reference team-generic 'team-column' args. Those
// block types were subsequently dropped from the model in favor of expanding team logic over the
// concrete _1/_2 columns. 0062 was corrected to emit the final shape directly, but databases that
// already ran the earlier 0062 hold the intermediate scope shape — this migration converts them.
//
// It is a no-op on databases that ran the corrected 0062 (no scope blocks / team-columns present),
// so both populations converge on the same final shape.
//
// Intermediate shapes handled:
//   { type: 'some-team',   neg, children }               => OR over both teams of AND(children)
//   { type: 'every-team',  neg, children }               => AND over both teams of AND(children)
//   { type: 'teams-split', neg, children: [A, B] }        => OR( AND(A@1,B@2), AND(A@2,B@1) )
//   arg { type: 'team-column', column: 'Alliance'|'Faction'|'Unit' } => { type: 'column', column: `${column}_${team}` }

type Node = any

const SCOPE_TYPES = new Set(['some-team', 'every-team', 'teams-split'])

// deep clone of a subtree, replacing every team-column arg with the concrete column for `team`
function resolveTeam(node: Node, team: 1 | 2): Node {
	const out: Node = { ...node }
	if (Array.isArray(node.args)) {
		out.args = node.args.map((arg: any) =>
			arg && arg.type === 'team-column'
				? { type: 'column', column: `${arg.column}_${team}` }
				: { ...arg }
		)
	}
	if (Array.isArray(node.children)) {
		out.children = node.children.map((c: Node) => resolveTeam(c, team))
	}
	return out
}

function andWrap(children: Node[]): Node {
	if (children.length === 1) return children[0]
	return { type: 'and', neg: false, children }
}

// bottom-up: transform children first (collapsing any nested scopes), then expand this node if a scope
function transform(node: Node): Node {
	if (Array.isArray(node.children)) {
		node = { ...node, children: node.children.map(transform) }
	}
	if (!SCOPE_TYPES.has(node.type)) return node

	const neg: boolean = node.neg ?? false
	const children: Node[] = node.children ?? []
	switch (node.type) {
		case 'some-team': {
			const body = andWrap(children)
			return { type: 'or', neg, children: [resolveTeam(body, 1), resolveTeam(body, 2)] }
		}
		case 'every-team': {
			const body = andWrap(children)
			return { type: 'and', neg, children: [resolveTeam(body, 1), resolveTeam(body, 2)] }
		}
		case 'teams-split': {
			const a = children[0] ?? { type: 'and', neg: false, children: [] }
			const b = children[1] ?? { type: 'and', neg: false, children: [] }
			return {
				type: 'or',
				neg,
				children: [
					{ type: 'and', neg: false, children: [resolveTeam(a, 1), resolveTeam(b, 2)] },
					{ type: 'and', neg: false, children: [resolveTeam(a, 2), resolveTeam(b, 1)] },
				],
			}
		}
		default:
			throw new Error(`unexpected scope type: ${node.type}`)
	}
}

export async function up(db: MigrationDriver): Promise<void> {
	const rows = db.prepare(`SELECT id, filter FROM filters`).all() as { id: string; filter: string }[]
	const update = db.prepare(`UPDATE filters SET filter = ? WHERE id = ?`)
	for (const row of rows) {
		const before = row.filter
		const transformed = transform(JSON.parse(before))
		const after = JSON.stringify(transformed)
		if (after !== before) update.run(after, row.id)
	}
}
