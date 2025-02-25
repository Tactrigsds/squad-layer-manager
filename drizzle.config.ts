import { defineConfig } from 'drizzle-kit'

import { ENV, ensureEnvSetup } from './src/server/env.ts'

ensureEnvSetup()

export default defineConfig({
	schema: './drizzle/schema.ts',
	out: './drizzle',
	dialect: 'mysql',
	dbCredentials: {
		host: ENV.DB_HOST,
		port: ENV.DB_PORT,
		user: ENV.DB_USER,
		password: ENV.DB_PASSWORD,
		database: ENV.DB_DATABASE,
	},
	strict: false,
})
