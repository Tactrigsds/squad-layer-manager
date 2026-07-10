import type { MigrationDriver } from '@/server/migrate'

// Folds the apply-filter node's `neg` flag into named operators, mirroring what 0065 did for blocks:
//   { type: 'apply-filter', neg: false, filterId } => { type: 'included-in',   filterId }
//   { type: 'apply-filter', neg: true,  filterId } => { type: 'excluded-from', filterId }
//
// Comparison nodes keep their `neg` flag; block nodes were already converted by 0065. Applied to the
// `filter` column of every row in the filters table. A no-op on filters holding no apply-filter nodes.

type Node = any

function transform(node: Node): Node {
	if (!node || typeof node !== 'object') return node

	const children = Array.isArray(node.children) ? node.children.map(transform) : undefined

	if (node.type === 'apply-filter') {
		const neg: boolean = node.neg ?? false
		return { type: neg ? 'excluded-from' : 'included-in', filterId: node.filterId }
	}

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
