import type { MigrationDriver } from '@/server/migrate'

// The `id` (layer id) column no longer supports `eq`; its only operation is the "select layers" node,
// an `in` over a list of layer ids. Fold every stored `id = X` / `id != X` comparison into the
// equivalent `id in [X]` (keeping `neg`, so `id != X` becomes `not in [X]`). `id = null` / `id != null`
// become `id in []` / `not in []`, which are truth-equivalent. Existing `id in [...]` nodes are left
// untouched. Applied to the `filter` column of every row in the filters table.

type Node = any

function isIdColumnArg(arg: any): boolean {
	return arg && typeof arg === 'object' && arg.type === 'column' && arg.column === 'id'
}

function transform(node: Node): Node {
	if (!node || typeof node !== 'object') return node
	if (Array.isArray(node.children)) {
		return { ...node, children: node.children.map(transform) }
	}
	if (node.type === 'eq' && Array.isArray(node.args) && isIdColumnArg(node.args[0])) {
		const valueArg = node.args[1]
		const value = valueArg && typeof valueArg === 'object' && valueArg.type === 'value' ? valueArg.value : undefined
		const values = value === null || value === undefined ? [] : [value]
		return { type: 'in', neg: node.neg ?? false, args: [node.args[0], { type: 'values', values }] }
	}
	return node
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
