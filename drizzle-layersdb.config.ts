import { defineConfig } from 'drizzle-kit'
import * as Env from './src/server/env'
import { LAYERS_DB_PATH } from './src/server/systems/layer-db.server'
import * as LayerDb from './src/server/systems/layer-db.server'

Env.ensureEnvSetup()
LayerDb.setupExtraColsConfig()

export default defineConfig({
	schema: './drizzle/schema-layersdb.ts',
	out: './drizzle',
	dialect: 'sqlite',
	dbCredentials: {
		url: LAYERS_DB_PATH,
	},
	strict: false,
})
