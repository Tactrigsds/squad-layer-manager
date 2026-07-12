import * as dotenv from 'dotenv'
import path from 'node:path'
import { z } from 'zod'
import * as Paths from '../../paths.ts'
import { NormedUrl, ParsedBigIntSchema, ParsedIntSchema, PathSegment } from '../lib/zod'
import * as Cli from '../systems/cli.server'

// comma-separated list of Discord snowflake ids parsed to bigints (e.g. SUPER_USERS="123,456")
const BigIntListSchema = z.string().default('').transform((val) => val.split(',').map((s) => s.trim()).filter(Boolean).map(BigInt))

export const groups = {
	general: {
		NODE_ENV: z.enum(['development', 'production', 'test']),
		LOG_LEVEL_OVERRIDE: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
		OTEL_ENABLED: z.stringbool().default(true),
		OTLP_COLLECTOR_ENDPOINT: NormedUrl.transform((url) => url.replace(/\/$/, '')).default('http://localhost:4318'),
		// Head sampling ratio for traces we root ourselves. Defaults to 1 (sample everything, the prior
		// behaviour); lower it if span volume from high-frequency ops becomes a problem.
		OTEL_TRACE_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(1),

		PUBLIC_GIT_SHA: z.string().min(1).prefault('unknown'),
		PUBLIC_GIT_BRANCH: z.string().min(1).prefault('unknown'),

		QUERY_PARAM_AUTH_BYPASS: z.stringbool().optional(),

		LOG_EXCLUDE_CONTEXT_PARAMS: z.string().default('').transform(val => new Set(val.split(',').map(s => s.trim()).filter(Boolean))),

		PUBLIC_REPO_URL: z.url().optional(),
		PUBLIC_ISSUES_URL: z.url().optional(),
	},

	squadcalc: {
		PUBLIC_SQUADCALC_URL: NormedUrl.default('https://squadcalc.app'),
	},

	rbac: {
		// Discord user/role ids that are always granted every permission (deploy-time bootstrap so an admin can never be locked out).
		// role/permission configuration otherwise lives in admin-editable global settings (see GlobalSettingsSchema.rbac).
		SUPER_USERS: BigIntListSchema,
		SUPER_ROLES: BigIntListSchema,
	},

	db: {
		DB_PATH: z.string().min(1).prefault('./data/main.sqlite3'),
		// When true, the server applies pending migrations itself at boot instead of refusing to
		// start (see db.ts setup()). Off by default: migrations run out-of-band via `pnpm db:migrate`
		// until the new migration system is proven. Unsafe to enable while another app instance runs.
		DB_AUTOMIGRATE: z.stringbool().default(false),
	},

	// only needed when running integration tests for the rcon modules
	testRcon: {
		TEST_RCON_HOST: z.string().min(1).prefault('localhost'),
		TEST_RCON_PORT: ParsedIntSchema.default(27015),
		TEST_RCON_PASSWORD: z.string().min(1).prefault('test'),
	},

	//
	discord: {
		DISCORD_CLIENT_ID: z.string().min(1),
		DISCORD_CLIENT_SECRET: z.string().min(1),
		DISCORD_BOT_TOKEN: z.string().min(1),
		DISCORD_HOME_GUILD_ID: ParsedBigIntSchema,
	},

	httpServer: {
		PORT: ParsedIntSchema.default(3000),
		HOST: z.string().prefault('127.0.0.1'),
		ORIGIN: NormedUrl.default('http://localhost:5173'),
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
		// The spreadsheet of OWI's layer spreadsheet. This is only used for layer sizes at the momenet
		SPREADSHEET_ID: z.string().prefault('1UXEgkUMBxhmYyEkaMSUd1Ko_I7s--7krCdyshZ076pU'),
		SPREADSHEET_MAP_LAYERS_GID: z.number().prefault(1212962563),
		EXTRA_COLS_CSV_PATH: z.string().prefault(path.join(Paths.DATA, 'layers_v{{LAYERS_VERSION}}.csv')),
	},

	battlemetrics: {
		BM_HOST: z.url().prefault('https://api.battlemetrics.com'),

		// Battlemetrics API Token.
		// Required permissions are:
		// - player flags (add/remove player flags. don't need to add new flags)
		// - player notes(read & createe)
		// - rcon(read, unclear why we need this one tbqh but experimentally seem to)
		BM_PAT: z.string({}).meta({
			description: `
                        `.trim(),
		}),

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
