import { ParsedIntSchema, StrFlag } from '../lib/zod'
import { createEnv } from '@t3-oss/env-core'
import * as dotenv from 'dotenv'
import { z } from 'zod'

export let ENV!: ReturnType<typeof setupEnv>
export type Env = typeof ENV
const EnvSchema = {
	NODE_ENV: z.enum(['development', 'production']),
	ORIGIN: z
		.string()
		.url()
		.default('http://localhost:5173')
		// trim trailing whitespace
		.transform((url) => url.replace(/\/$/, '')),

	DB_HOST: z.string().min(1).default('localhost'),
	DB_PORT: ParsedIntSchema.default('3306'),
	DB_USER: z.string().min(1).default('root'),
	DB_PASSWORD: z.string().min(1).default('dev'),
	DB_DATABASE: z.string().min(1),
	DB_DATABASE_SQUADJS: z.string().min(1),

	USING_DEVTOOLS: StrFlag.default('false'),

	DISCORD_CLIENT_ID: z.string().min(1),
	DISCORD_CLIENT_SECRET: z.string().min(1),
	DISCORD_BOT_TOKEN: z.string().min(1),

	LOG_LEVEL_OVERRIDE: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),

	RCON_HOST: z.string().min(1).default('localhost'),
	RCON_PORT: z
		.string()
		.transform((val) => parseInt(val, 10))
		.pipe(z.number().int().positive())
		.default('21114'),
	RCON_PASSWORD: z.string().default('testpassword'),

	PORT: ParsedIntSchema.default('3000'),
	HOST: z.string().default('127.0.0.1'),

	OLTP_COLLECTOR_ENDPOINT: z
		.string()
		.url()
		.default('http://localhost:4318')
		// trim trailing whitespace
		.transform((url) => url.replace(/\/$/, ''))
		.describe('Endpoint for the OLTP collector'),

	PUBLIC_GIT_SHA: z.string().nonempty().default('unknown'),
	PUBLIC_GIT_BRANCH: z.string().nonempty().default('unknown'),
}

export function ensureEnvSetup() {
	if (!ENV) setupEnv()
}

function setupEnv() {
	dotenv.config()
	const runtimeEnv = Object.fromEntries(Object.keys(EnvSchema).map((key) => [key, process.env[key]]))
	const env = createEnv({
		server: EnvSchema,
		runtimeEnv: runtimeEnv,
	})

	ENV = env
	return env
}
