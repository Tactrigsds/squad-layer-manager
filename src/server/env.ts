import { createEnv } from '@t3-oss/env-core'
import dotenv from 'dotenv'
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
	NODE_ENV: z.enum(['development'], { message: 'TODO configure prod' }),
	ORIGIN: z.string().url(),

	DB_HOST: z.string().min(1),
	DB_PORT: z
		.string()
		.transform((val) => parseInt(val, 10))
		.pipe(z.number().int().positive().default(21114)),
	DB_USER: z.string().min(1),
	DB_PASSWORD: z.string().min(1),
	DB_DATABASE: z.string().min(1),

	USING_DEVTOOLS: Flag.default('false'),

	DISCORD_CLIENT_ID: z.string().min(1),
	DISCORD_CLIENT_SECRET: z.string().min(1),

	LOG_LEVEL_OVERRIDE: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
	MOCK_SQUAD_SERVER: Flag.default('false'),

	RCON_HOST: z.string().min(1),
	RCON_PORT: z
		.string()
		.transform((val) => parseInt(val, 10))
		.pipe(z.number().int().positive().default(21114)),
	RCON_PASSWORD: z.string().optional(),
}
export function setupEnv() {
	dotenv.config()
	const runtimeEnv = {
		NODE_ENV: process.env.NODE_ENV,
		ORIGIN: process.env.ORIGIN,

		DB_HOST: process.env.DB_HOST,
		DB_PORT: process.env.DB_PORT,
		DB_USER: process.env.DB_USER,
		DB_PASSWORD: process.env.DB_PASSWORD,
		DB_DATABASE: process.env.DB_DATABASE,

		USING_DEVTOOLS: process.env.USING_DEVTOOLS,

		DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
		DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,

		LOG_LEVEL_OVERRIDE: process.env.LOG_LEVEL_OVERRIDE,
		MOCK_SQUAD_SERVER: process.env.MOCK_SQUAD_SERVER,
		RCON_HOST: process.env.RCON_HOST,
		RCON_PORT: process.env.RCON_PORT,
	}
	console.log(runtimeEnv)

	const env = createEnv({
		server: EnvSchema,
		runtimeEnv: runtimeEnv,
	})

	ENV = env
	return env
}
