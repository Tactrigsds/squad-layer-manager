import type { MigrationDriver } from '@/server/migrate'

// Renames the four block operators from their colloquial ids to the boolean operation each one is:
//   all    => and
//   some   => or
//   none   => nor
//   notall => nand
// Semantics are unchanged; this is purely the stored `type` string. Applied to the `filter` column of
// every row in the filters table. Only nodes carrying `children` are block nodes, so the rename is
// gated on that -- no other node type uses these names.

type Node = any

const RENAMED: Record<string, string> = { all: 'and', some: 'or', none: 'nor', notall: 'nand' }

function transform(node: Node): Node {
	if (!node || typeof node !== 'object') return node
	if (!Array.isArray(node.children)) return node

	const children = node.children.map(transform)
	const type = RENAMED[node.type] ?? node.type
	return { ...node, type, children }
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
