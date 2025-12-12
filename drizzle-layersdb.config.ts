import { defineConfig } from 'drizzle-kit'
import * as Env from './src/server/env'
import * as LayerDb from './src/server/systems/layer-db'

Env.ensureEnvSetup()
LayerDb.setupExtraColsConfig()
const envBuilder = Env.getEnvBuilder({ ...Env.groups.layerDb })
const ENV = envBuilder()

export default defineConfig({
	schema: './drizzle/schema-layersdb.ts',
	out: './drizzle',
	dialect: 'sqlite',
	dbCredentials: {
		url: ENV.LAYERS_DB_PATH,
	},
	strict: false,
})
