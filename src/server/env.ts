import * as dotenv from 'dotenv'
import { z } from 'zod'
import { HumanTime, ParsedIntSchema, StrFlag } from '../lib/zod'
import * as Cli from './systems/cli.ts'

export const groups = {
	general: {
		NODE_ENV: z.enum(['development', 'production']),
		LOG_LEVEL_OVERRIDE: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
		OTLP_COLLECTOR_ENDPOINT: z
			.string()
			.url()
			.default('http://localhost:4318')
			// trim trailing whitespace
			.transform((url) => url.replace(/\/$/, ''))
			.describe('Endpoint for the OLTP collector'),

		PUBLIC_GIT_SHA: z.string().nonempty().default('unknown'),
		PUBLIC_GIT_BRANCH: z.string().nonempty().default('unknown'),
	},

	db: {
		DB_HOST: z.string().nonempty().default('localhost'),
		DB_PORT: ParsedIntSchema.default('3306'),
		DB_USER: z.string().nonempty().default('root'),
		DB_PASSWORD: z.string().nonempty().default('dev'),
		DB_DATABASE: z.string().nonempty().default('squadLayerManager'),
	},

	discord: {
		DISCORD_CLIENT_ID: z.string().nonempty(),
		DISCORD_CLIENT_SECRET: z.string().nonempty(),
		DISCORD_BOT_TOKEN: z.string().nonempty(),
	},

	rcon: {
		RCON_HOST: z.string().nonempty().default('localhost'),
		RCON_PORT: z
			.string()
			.transform((val) => parseInt(val, 10))
			.pipe(z.number().int().positive())
			.default('21114'),
		RCON_PASSWORD: z.string().default('testpassword'),
	},

	httpServer: {
		PORT: ParsedIntSchema.default('3000'),
		HOST: z.string().default('127.0.0.1'),
		ORIGIN: z
			.string()
			.url()
			.default('http://localhost:5173')
			// trim trailing slash
			.transform((url) => url.replace(/\/$/, '')),
	},

	squadSftpLogs: {
		SQUAD_SFTP_HOST: z.string().default('localhost'),
		SQUAD_SFTP_PORT: ParsedIntSchema.default('22'),
		SQUAD_SFTP_LOG_FILE: z.string().default('squad-sftp.log'),
		SQUAD_SFTP_USERNAME: z.string().default('squad'),
		SQUAD_SFTP_PASSWORD: z.string().default('password'),
		SQUAD_SFTP_POLL_INTERVAL: HumanTime.default('5s').pipe(z.number().positive()),
	},
} satisfies { [key: string]: Record<string, z.ZodTypeAny> }

let rawEnv!: Record<string, string | undefined>

export function getEnvBuilder<G extends Record<string, z.ZodTypeAny>>(groups: G) {
	return () => z.object(groups).parse({ ...rawEnv })
}

let setup = false

export function ensureEnvSetup() {
	if (setup) return
	dotenv.config({ path: Cli.options?.envFile })
	rawEnv = {}
	for (
		const key of Object.values(groups).flatMap(g => Object.keys(g))
	) {
		if (process.env[key]) {
			rawEnv[key] = process.env[key]
		}
	}
	setup = true
}
