import * as dotenv from 'dotenv'
import path from 'node:path'
import { z } from 'zod'
import * as Paths from '../../paths.ts'
import { HumanTime, NormedUrl, ParsedIntSchema, StrFlag } from '../lib/zod'
import * as Cli from './systems/cli.ts'

export const groups = {
	general: {
		NODE_ENV: z.enum(['development', 'production', 'test']),
		LOG_LEVEL_OVERRIDE: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
		OTLP_COLLECTOR_ENDPOINT: NormedUrl.transform((url) => url.replace(/\/$/, '')).default('http://localhost:4318'),

		PUBLIC_GIT_SHA: z.string().nonempty().default('unknown'),
		PUBLIC_GIT_BRANCH: z.string().nonempty().default('unknown'),

		REACT_SCAN_ENABLED_OVERRIDE: StrFlag.optional(),
	},

	squadcalc: {
		PUBLIC_SQUADCALC_URL: NormedUrl.default('https://squadcalc.app'),
	},

	db: {
		DB_HOST: z.string().nonempty().default('localhost'),
		DB_PORT: ParsedIntSchema.default('3306'),
		DB_USER: z.string().nonempty().default('root'),
		DB_PASSWORD: z.string().nonempty().default('dev'),
		DB_DATABASE: z.string().nonempty().default('squadLayerManager'),
	},

	// only needed when running integration tests for the rcon modules
	testRcon: {
		TEST_RCON_HOST: z.string().nonempty().default('localhost'),
		TEST_RCON_PORT: ParsedIntSchema.default('27015'),
		TEST_RCON_PASSWORD: z.string().nonempty().default('test'),
	},

	discord: {
		DISCORD_CLIENT_ID: z.string().nonempty(),
		DISCORD_CLIENT_SECRET: z.string().nonempty(),
		DISCORD_BOT_TOKEN: z.string().nonempty(),
	},

	httpServer: {
		PORT: ParsedIntSchema.default('3000'),
		HOST: z.string().default('127.0.0.1'),
		ORIGIN: NormedUrl.default('https://localhost:5173'),
	},

	layerDb: {
		LAYER_DB_CONFIG_PATH: z.string().default('./layer-db.json'),
		LAYERS_DB_PATH: z.string().default('./data/layers.sqlite3'),
	},

	preprocess: {
		SPREADSHEET_ID: z.string().default('1Rv7WpDN7UutQjyK7opSOr6BodGcZDrTnuAwp_4U63J4'),
		SPREADSHEET_MAP_LAYERS_GID: z.number().default(1212962563),
		EXTRA_COLS_CSV_PATH: z.string().default(path.join(Paths.DATA, 'layers.csv')),
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
