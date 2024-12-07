import { createEnv } from '@t3-oss/env-core'
import * as dotenv from 'dotenv'
import { z } from 'zod'

const Flag = z
	.string()
	.toLowerCase()
	.pipe(z.union([z.literal('true'), z.literal('false')]))
	.transform((val) => val === 'true')
	.pipe(z.boolean())

export let ENV!: ReturnType<typeof setupEnv>
export type Env = typeof ENV
const EnvSchema = {
	NODE_ENV: z.enum(['development', 'production'], { message: 'TODO configure prod' }),
	ORIGIN: z.string().url(),

	DB_HOST: z.string().min(1).default('localhost'),
	DB_PORT: z
		.string()
		.transform((val) => parseInt(val, 10))
		.pipe(z.number().int().positive())
		.default('3306'),
	DB_USER: z.string().min(1),
	DB_PASSWORD: z.string().min(1),
	DB_DATABASE: z.string().min(1),
	DB_DATABASE_SQUADJS: z.string().min(1),

	USING_DEVTOOLS: Flag.default('false'),

	DISCORD_CLIENT_ID: z.string().min(1),
	DISCORD_CLIENT_SECRET: z.string().min(1),
	DISCORD_BOT_TOKEN: z.string().min(1),

	LOG_LEVEL_OVERRIDE: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
	MOCK_SQUAD_SERVER_PATH: z.string().optional(),

	RCON_HOST: z.string().min(1),
	RCON_PORT: z
		.string()
		.transform((val) => parseInt(val, 10))
		.pipe(z.number().int().positive())
		.default('21114'),
	RCON_PASSWORD: z.string(),

	PORT: z.number().int().positive().default(3000),
	HOST: z.string().default('127.0.0.1'),

	PROD_LOG_PATH: z.string().min(1).optional().describe('Path to write logs to in production'),
}

export function setupEnv() {
	dotenv.config()
	const runtimeEnv = Object.fromEntries(Object.keys(EnvSchema).map((key) => [key, process.env[key]]))
	const env = createEnv({
		server: EnvSchema,
		runtimeEnv: runtimeEnv,
	})

	ENV = env
	return env
}
