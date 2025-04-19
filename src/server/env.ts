import { createEnv } from '@t3-oss/env-core'
import * as dotenv from 'dotenv'
import { z } from 'zod'
import { HumanTime, ParsedIntSchema, StrFlag } from '../lib/zod'
import * as Cli from './systems/cli.ts'

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

	DB_HOST: z.string().nonempty().default('localhost'),
	DB_PORT: ParsedIntSchema.default('3306'),
	DB_USER: z.string().nonempty().default('root'),
	DB_PASSWORD: z.string().nonempty().default('dev'),
	DB_DATABASE: z.string().nonempty(),

	USING_DEVTOOLS: StrFlag.default('false'),

	DISCORD_CLIENT_ID: z.string().nonempty(),
	DISCORD_CLIENT_SECRET: z.string().nonempty(),
	DISCORD_BOT_TOKEN: z.string().nonempty(),

	LOG_LEVEL_OVERRIDE: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),

	RCON_HOST: z.string().nonempty().default('localhost'),
	RCON_PORT: z
		.string()
		.transform((val) => parseInt(val, 10))
		.pipe(z.number().int().positive())
		.default('21114'),
	RCON_PASSWORD: z.string().default('testpassword'),

	PORT: ParsedIntSchema.default('3000'),
	HOST: z.string().default('127.0.0.1'),

	OTLP_COLLECTOR_ENDPOINT: z
		.string()
		.url()
		.default('http://localhost:4318')
		// trim trailing whitespace
		.transform((url) => url.replace(/\/$/, ''))
		.describe('Endpoint for the OLTP collector'),

	PUBLIC_GIT_SHA: z.string().nonempty().default('unknown'),
	PUBLIC_GIT_BRANCH: z.string().nonempty().default('unknown'),

	SQUAD_SFTP_HOST: z.string().default('localhost'),
	SQUAD_SFTP_PORT: ParsedIntSchema.default('22'),
	SQUAD_SFTP_LOG_FILE: z.string().default('squad-sftp.log'),
	SQUAD_SFTP_USERNAME: z.string().default('squad'),
	SQUAD_SFTP_PASSWORD: z.string().default('password'),
	SQUAD_SFTP_POLL_INTERVAL: HumanTime.default('5s').pipe(z.number().min(1)),
}

export function ensureEnvSetup() {
	if (!ENV) setupEnv()
}

function setupEnv() {
	dotenv.config({ path: Cli.options?.envFile })
	const runtimeEnv = Object.fromEntries(Object.keys(EnvSchema).map((key) => [key, process.env[key]]))
	const env = createEnv({
		server: EnvSchema,
		runtimeEnv: runtimeEnv,
	})

	ENV = env
	return env
}
