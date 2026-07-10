import type { MigrationDriver } from '@/server/migrate'

// Folds the old boolean block shape ({ type: 'and' | 'or', neg, children }) into the four named
// block operators, dropping the separate `neg` flag on blocks (negation is now intrinsic to the
// operator):
//   and, neg=false  => all     (every child matches)
//   and, neg=true   => notall  (not every child matches)
//   or,  neg=false  => some    (at least one child matches)
//   or,  neg=true   => none    (no child matches)
//
// Comparison and apply-filter nodes keep their `neg` flag untouched. Applied to the `filter` column
// of every row in the filters table. A no-op on filters that hold no legacy and/or blocks.

type Node = any

function transform(node: Node): Node {
	if (!node || typeof node !== 'object') return node

	const children = Array.isArray(node.children) ? node.children.map(transform) : undefined

	if (node.type === 'and' || node.type === 'or') {
		const neg: boolean = node.neg ?? false
		const type = node.type === 'and' ? (neg ? 'notall' : 'all') : (neg ? 'none' : 'some')
		return { type, children: children ?? [] }
	}

	// non-block node: recurse into any children (defensive) but leave the node otherwise intact
	return children ? { ...node, children } : node
}

export async function up(db: MigrationDriver): Promise<void> {
	const rows = db.prepare(`SELECT id, filter FROM filters`).all() as { id: string; filter: string }[]
	const update = db.prepare(`UPDATE filters SET filter = ? WHERE id = ?`)
	for (const row of rows) {
		const before = row.filter
		const after = JSON.stringify(transform(JSON.parse(before)))
		if (after !== before) update.run(after, row.id)
	}
}
