import type { MigrationDriver } from '@/server/migrate'

// The Community collection is gone: its nine layers are part of OWI now. Two things persisted before this
// spelled it out and no longer resolve.
//
// Layer ids carried the collection's `CL` abbreviation (`FL-INV-V3-CL:USA-CA:RGF-CA`), which the app now writes
// without (`FL-INV-V3:USA-CA:RGF-CA`). The parser still accepts the old spelling, so nothing breaks unmigrated,
// but a stored id only compares equal to a generated one once it is rewritten.
//
// Filter nodes comparing the Collection column against 'Community' match nothing at all, so those are folded
// into 'OWI'. Both live inside otherwise-opaque JSON documents (filters, queues, backburner, settings), so this
// walks the documents rather than knowing their shapes.
//
// Only the vanilla layer names changed; `Fallujah_Invasion_v3_CL` is still the Layer column value and still the
// string sent to the game server, so raw layer text is left alone.

type Json = unknown

const LAYER_ID_WITH_CL = /^([A-Za-z]+-[A-Za-z]+(?:-V\d+)?)-CL(:[A-Za-z0-9_]+(?:-[A-Za-z]+)?:[A-Za-z0-9_]+(?:-[A-Za-z]+)?)$/

function rewriteLayerId(value: string): string {
	return value.replace(LAYER_ID_WITH_CL, '$1$2')
}

function foldCollectionValues(values: unknown[]): unknown[] {
	const folded = values.map((value) => (value === 'Community' ? 'OWI' : value))
	// superjson meta can reference an array position, but only for values it had to annotate, which a list of
	// collection names never has. Deduping is safe exactly when every element is a plain string.
	if (!folded.every((value) => typeof value === 'string')) return folded
	return [...new Set(folded as string[])]
}

function isCollectionColumnArg(arg: any): boolean {
	return !!arg && typeof arg === 'object' && arg.type === 'column' && arg.column === 'Collection'
}

function rewrite(node: Json): Json {
	if (typeof node === 'string') return rewriteLayerId(node)
	if (Array.isArray(node)) return node.map(rewrite)
	if (!node || typeof node !== 'object') return node

	const obj = node as Record<string, any>
	if (Array.isArray(obj.args) && isCollectionColumnArg(obj.args[0])) {
		const [column, operand] = obj.args
		if (operand && typeof operand === 'object') {
			if (operand.type === 'value' && operand.value === 'Community') {
				return { ...obj, args: [column, { ...operand, value: 'OWI' }] }
			}
			if (operand.type === 'values' && Array.isArray(operand.values)) {
				return { ...obj, args: [column, { ...operand, values: foldCollectionValues(operand.values) }] }
			}
		}
	}

	const out: Record<string, Json> = {}
	for (const [key, value] of Object.entries(obj)) out[key] = rewrite(value)
	return out
}

function rewriteColumn(db: MigrationDriver, table: string, key: string, column: string) {
	const rows = db.prepare(`SELECT ${key} AS key, ${column} AS value FROM ${table}`).all() as { key: unknown; value: string | null }[]
	const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${key} = ?`)
	for (const row of rows) {
		if (!row.value) continue
		const after = JSON.stringify(rewrite(JSON.parse(row.value)))
		if (after !== row.value) update.run(after, row.key)
	}
}

export async function up(db: MigrationDriver): Promise<void> {
	rewriteColumn(db, 'filters', 'id', 'filter')
	for (const column of ['layerQueue', 'backburner', 'settings']) {
		rewriteColumn(db, 'servers', 'id', column)
	}
	rewriteColumn(db, 'globalSettings', 'id', 'settings')

	const matches = db.prepare(`SELECT id, layerId FROM matchHistory WHERE layerId LIKE '%-CL:%'`).all() as {
		id: number
		layerId: string
	}[]
	const updateMatch = db.prepare(`UPDATE matchHistory SET layerId = ? WHERE id = ?`)
	for (const match of matches) {
		const after = rewriteLayerId(match.layerId)
		if (after !== match.layerId) updateMatch.run(after, match.id)
	}
}
