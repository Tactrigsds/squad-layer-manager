import { defineConfig } from 'drizzle-kit'

import { ENV, setupEnv } from './src/server/env.ts'

setupEnv()

export default defineConfig({
	schema: './src/server/schema.ts',
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
