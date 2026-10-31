import DatabaseConstructor from 'better-sqlite3'
import path from 'node:path'
import { expect, test } from 'vitest'

import { tsMigrations } from '@/migrations/registry'
import * as DB from '@/server/db'
import * as Migrate from '@/server/migrate'
import * as Sql from '@/server/sql'

// Every defined statement, prepared against the database the migrations build, with its query plan checked for table
// scans it did not declare. The snapshot lists each statement's SQL, so a change to one shows up in review.

const root = path.resolve(import.meta.dirname, '../..')

test('every defined statement prepares and scans only what it declares', async () => {
	const systems = import.meta.glob(['/src/systems/*.server.ts', '/src/systems/*.shared.ts'])
	await Promise.all(Object.values(systems).map((load) => load()))
	const driver = new DatabaseConstructor(':memory:')
	await Migrate.runMigrations(driver, { sqlDir: path.join(root, 'drizzle-sqlite'), tsMigrations })
	expect(DB.checkStatements(DB.connect(driver))).toEqual([])

	const snapshot = [...Sql.registry.values()]
		.flatMap((r) => [...r.entries()].map((e) => `${e.name}\n  ${e.text}\n`))
		.sort()
		.join('\n')
	await expect(snapshot).toMatchFileSnapshot('./statements.snapshot.txt')
})
