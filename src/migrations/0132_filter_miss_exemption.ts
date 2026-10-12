import type { MigrationDriver } from '@/server/migrate'

// filters += missExemption: the layers that never show the filter's miss indicator, as a filter node.
//
// Every existing filter is given the default, seeding and training layers, which is the set that queue warnings
// already skipped for every filter. The exception is the `seeding` filter a fresh install seeds: a seeding or
// training layer outside it is the miss it exists to point out, so it exempts nothing.

const DEFAULT_MISS_EXEMPTION = {
	type: 'or',
	children: [
		{
			type: 'in',
			neg: false,
			args: [
				{ type: 'column', column: 'Gamemode' },
				{ type: 'values', values: ['Seed', 'Training'] },
			],
		},
	],
}

function hasColumn(db: MigrationDriver, table: string, column: string): boolean {
	const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
	return columns.some((c) => c.name === column)
}

export async function up(db: MigrationDriver): Promise<void> {
	if (hasColumn(db, 'filters', 'missExemption')) return
	db.exec(`ALTER TABLE filters ADD COLUMN missExemption text`)
	db.prepare(`UPDATE filters SET missExemption = ? WHERE id != 'seeding'`).run(JSON.stringify(DEFAULT_MISS_EXEMPTION))
}
