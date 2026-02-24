import * as dotenv from 'dotenv'
import path from 'node:path'
import { z } from 'zod'
import * as Paths from '../../paths.ts'
import { NormedUrl, ParsedIntSchema, PathSegment } from '../lib/zod'
import * as Cli from '../systems/cli.server'

export const groups = {
	general: {
		NODE_ENV: z.enum(['development', 'production', 'test']),
		LOG_LEVEL_OVERRIDE: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
		OTLP_COLLECTOR_ENDPOINT: NormedUrl.transform((url) => url.replace(/\/$/, '')).default('http://localhost:4318'),

		PUBLIC_GIT_SHA: z.string().min(1).prefault('unknown'),
		PUBLIC_GIT_BRANCH: z.string().min(1).prefault('unknown'),

		REACT_SCAN_ENABLED_OVERRIDE: z.stringbool().optional(),

		QUERY_PARAM_AUTH_BYPASS: z.stringbool().optional(),
	},

	squadcalc: {
		PUBLIC_SQUADCALC_URL: NormedUrl.default('https://squadcalc.app'),
	},

	db: {
		DB_HOST: z.string().min(1).prefault('localhost'),
		DB_PORT: ParsedIntSchema.default(3306),
		DB_USER: z.string().min(1).prefault('root'),
		DB_PASSWORD: z.string().min(1).prefault('dev'),
		DB_DATABASE: z.string().min(1).prefault('squadLayerManager'),
	},

	// only needed when running integration tests for the rcon modules
	testRcon: {
		TEST_RCON_HOST: z.string().min(1).prefault('localhost'),
		TEST_RCON_PORT: ParsedIntSchema.default(27015),
		TEST_RCON_PASSWORD: z.string().min(1).prefault('test'),
	},

	discord: {
		DISCORD_CLIENT_ID: z.string().min(1),
		DISCORD_CLIENT_SECRET: z.string().min(1),
		DISCORD_BOT_TOKEN: z.string().min(1),
	},

	httpServer: {
		PORT: ParsedIntSchema.default(3000),
		HOST: z.string().prefault('127.0.0.1'),
		ORIGIN: NormedUrl.default('https://localhost:5173'),
	},

	squadLogsReceiver: {
		SQUAD_LOGS_RECEIVER_PORT: ParsedIntSchema.default(8443),
	},

	layerDb: {
		LAYERS_VERSION: PathSegment.default('@latest'), // @latest is a magic string which resolves the latest available version according to semver that's availble at the configured path for  LAYERS_DB_PATH and EXTRA_COLS_CSV_PATH
		LAYER_DB_CONFIG_PATH: z.string().prefault('./layer-db.json'),
		LAYERS_DB_PATH: z.string().prefault('./data/layers_v{{LAYERS_VERSION}}.sqlite3.gz'),
	},

	preprocess: {
		SPREADSHEET_ID: z.string().prefault('1zFxpVAJzm2-eT8anabUwcjyyo7t0vUn4cVBqAGn1z-o'),
		SPREADSHEET_MAP_LAYERS_GID: z.number().prefault(1212962563),
		EXTRA_COLS_CSV_PATH: z.string().prefault(path.join(Paths.DATA, 'layers_v{{LAYERS_VERSION}}.csv')),
	},

	battlemetrics: {
		BM_HOST: z.url().prefault('https://api.battlemetrics.com'),
		// BM_ORG_ID: z.string(),
		BM_PAT: z.string(),
		BM_ORG_ID: z.string(),
	},
} satisfies { [key: string]: Record<string, z.ZodType> }

let rawEnv!: Record<string, string | undefined>

const parsedProperties = new Map<string, unknown>()

function parseGroups<G extends Record<string, z.ZodType>>(groups: G) {
	return z.object(groups).parse(rawEnv)
}

export function getEnvBuilder<G extends Record<string, z.ZodType>>(groups: G) {
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

const buildForValidation = getEnvBuilder({
	NODE_ENV: groups.general.NODE_ENV,
	QUERY_PARAM_AUTH_BYPASS: groups.general.QUERY_PARAM_AUTH_BYPASS,
})

export function ensureEnvSetup() {
	if (setup) return
	if (Cli.options) {
		dotenv.config({ path: Cli.options.envFile })
	}
	rawEnv = {}
	for (
		const key of Object.values(groups).flatMap(g => Object.keys(g))
	) {
		if (process.env[key]) {
			rawEnv[key] = process.env[key]
		}
	}

	const toValidate = buildForValidation()
	if (toValidate.NODE_ENV === 'production' && toValidate.QUERY_PARAM_AUTH_BYPASS) {
		throw new Error('QUERY_PARAM_AUTH_BYPASS=true is not allowed in production')
	}

	setup = true
}
