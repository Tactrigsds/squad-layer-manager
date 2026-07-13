import Database from 'better-sqlite3'
import { defineConfig } from 'drizzle-kit'

// Read DB_PATH straight from the environment rather than through src/server/env,
// so this config can load inside the slim production image (which ships neither
// the source tree nor devDeps). In dev DB_PATH is unset and falls back to the
// default below; in prod it is provided via `docker run --env-file`. Keep this
// default in sync with the `db` group default in src/server/env.ts.
const DB_PATH = process.env.DB_PATH ?? './data/db.sqlite3'

// ensure that the database exists
const driver = Database(DB_PATH, { fileMustExist: false })
driver.close()

export default defineConfig({
	schema: './drizzle/schema.ts',
	out: './drizzle-sqlite',
	dialect: 'sqlite',
	dbCredentials: {
		url: DB_PATH,
	},
	strict: false,
})
