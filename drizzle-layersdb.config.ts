import Database from 'better-sqlite3'
import { defineConfig } from 'drizzle-kit'
import * as Env from './src/server/env'
import * as LayerDb from './src/server/systems/layer-db'

Env.ensureEnvSetup()
LayerDb.setupExtraColsConfig()
const envBuilder = Env.getEnvBuilder({ ...Env.groups.layerDb })
const ENV = envBuilder()
const [dbPath] = LayerDb.getVersionTemplatedPath(ENV.LAYERS_DB_PATH)

// ensure that the database exists
let driver = Database(dbPath, { fileMustExist: false })
driver.close()

export default defineConfig({
	schema: './drizzle/schema-layersdb.ts',
	out: './drizzle',
	dialect: 'sqlite',
	dbCredentials: {
		url: dbPath,
	},
	strict: false,
})
