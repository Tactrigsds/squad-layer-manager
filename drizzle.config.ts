import Database from 'better-sqlite3'
import { defineConfig } from 'drizzle-kit'
import * as Env from './src/server/env'

Env.ensureEnvSetup()
const envBuilder = Env.getEnvBuilder({ ...Env.groups.db })
const ENV = envBuilder()

// ensure that the database exists
const driver = Database(ENV.DB_PATH, { fileMustExist: false })
driver.close()

export default defineConfig({
	schema: './drizzle/schema.ts',
	out: './drizzle-sqlite',
	dialect: 'sqlite',
	dbCredentials: {
		url: ENV.DB_PATH,
	},
	strict: false,
})
