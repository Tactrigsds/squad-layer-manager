import { defineConfig } from 'drizzle-kit'

import { ENV, setupEnv } from './src/server/env.ts'

setupEnv()

export default defineConfig({
	schema: './drizzle/schema-squadjs.ts',
	out: './drizzle-squadjs',
	dialect: 'mysql',
	dbCredentials: {
		host: ENV.DB_HOST,
		port: ENV.DB_PORT,
		user: ENV.DB_USER,
		password: ENV.DB_PASSWORD,
		database: ENV.DB_DATABASE_SQUADJS,
	},
	strict: false,
})
