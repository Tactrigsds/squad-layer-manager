import * as LayerDb from '@/server/systems/layer-db.server.ts'
import * as dotenv from 'dotenv'
import { z } from 'zod'
import { HumanTime, NormedUrl, ParsedIntSchema } from '../lib/zod'
import * as Cli from './systems/cli.ts'

export const groups = {
	general: {
		NODE_ENV: z.enum(['development', 'production', 'test']),
		LOG_LEVEL_OVERRIDE: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
		OTLP_COLLECTOR_ENDPOINT: NormedUrl.transform((url) => url.replace(/\/$/, '')).default('http://localhost:4318'),

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
		RCON_PORT: ParsedIntSchema.default('21114').pipe(z.number().positive()),
		RCON_PASSWORD: z.string().default('testpassword'),
	},

	httpServer: {
		PORT: ParsedIntSchema.default('3000'),
		HOST: z.string().default('127.0.0.1'),
		ORIGIN: NormedUrl.default('http://localhost:5173'),
	},

	squadSftpLogs: {
		SQUAD_SFTP_HOST: z.string().default('localhost'),
		SQUAD_SFTP_PORT: ParsedIntSchema.default('22'),
		SQUAD_SFTP_LOG_FILE: z.string().default('squad-sftp.log'),
		SQUAD_SFTP_USERNAME: z.string().default('squad'),
		SQUAD_SFTP_PASSWORD: z.string().default('password'),
		SQUAD_SFTP_POLL_INTERVAL: HumanTime.default('5s').pipe(z.number().positive()),
	},

	layerDb: {
		LAYER_DB_CONFIG_PATH: z.string().default('./layer-db.json'),
		LAYERS_DB_PATH: z.string().default('./data/layers.sqlite3'),
	},

	sheets: {
		SPREADHSEET_ID: z.string().default('1A3D4zeOS8YxoEYrWcXa8edBCG_EUueZK9cX2oFMLY9U'),
	},
} satisfies { [key: string]: Record<string, z.ZodTypeAny> }

let rawEnv!: Record<string, string | undefined>

const parsedProperties = new Map<string, object>()

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function parseGroups<G extends Record<string, z.ZodTypeAny>>(groups: G) {
	return z.object(groups).parse(rawEnv)
}

export function getEnvBuilder<G extends Record<string, z.ZodTypeAny>>(groups: G) {
	return () => {
		const res: Record<string, any> = {}
		const errors: string[] = []

		for (const [key, schema] of Object.entries(groups)) {
			const cached = parsedProperties.get(key)
			if (cached) {
				res[key] = cached
			} else {
				const parsed = schema.safeParse(rawEnv[key])
				if (!parsed.success) {
					errors.push(`Invalid value for ${key}: ${JSON.stringify(parsed.error)}`)
				} else {
					parsedProperties.set(key, parsed.data)
					res[key] = parsed.data
				}
			}
		}

		if (errors.length > 0) {
			throw new Error(`Env errors:\n${errors.join('\n\n')}`)
		}

		return res as ReturnType<typeof parseGroups<G>>
	}
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
