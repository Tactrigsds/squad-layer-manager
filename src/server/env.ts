import * as dotenv from 'dotenv'
import * as Crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import * as Paths from '../../paths.ts'
import { HumanTime, NormedUrl, ParsedBigIntSchema, ParsedIntSchema, PathSegment } from '../lib/zod'
import * as Cli from '../systems/cli.server'

// how a var is written into the example env files, which are regenerated from this file on every dev boot
// (see env-example.ts). `description` is a plain GlobalMeta field and becomes the comment above the var.
type EnvExampleEntry = {
	// 'set' is written uncommented (either the implementor has to fill it in, or the file presets it),
	// 'commented' commented-out, 'omit' not at all. Inferred when left out: a var the schema rejects as
	// undefined is 'set', anything else is 'commented'.
	include?: 'set' | 'commented' | 'omit'
	// a value the file presets because the schema's default is the wrong one for this audience. Never a
	// placeholder example: a commented-out var shows its real default and nothing else, so that uncommenting
	// a line can't change behaviour. Anything worth illustrating goes in the description.
	value?: string
}

export type EnvExampleMeta = EnvExampleEntry & {
	// overrides for .env.example.dev, which someone running the app from a checkout copies. Anything not
	// overridden here is inherited from the entry above, which is what .env.example (a deployment) gets.
	dev?: EnvExampleEntry & {
		// replaces the top-level `description` in the dev file. For the handful of vars whose explanation is
		// only true of, or only useful to, one of the two audiences; the deployment file has no use for
		// vite, `pnpm db:migrate` or anything else that only exists in a checkout.
		description?: string
	}
}

declare module 'zod' {
	interface GlobalMeta {
		envExample?: EnvExampleMeta
		// the var holds a credential: it is read from the secrets file (see readSecretsFile) and written to
		// .env.secrets.example rather than .env.example. docs/INSTALLING.md covers why.
		secret?: true
	}
}

// The key .env.example.dev ships, so a checkout boots without a key-generation step. It says what it is,
// where a random-looking string would not; production refuses to start with it (see ensureEnvSetup).
export const INSECURE_DEV_ENCRYPTION_KEY = 'A_VERY_INSECURE_ENCRYPTION_KEY'

// comma-separated list of Discord snowflake ids parsed to bigints (e.g. SUPER_USERS="123,456")
const BigIntListSchema = z.string().default('').transform((val) => val.split(',').map((s) => s.trim()).filter(Boolean).map(BigInt))

export const groups = {
	general: {
		NODE_ENV: z.enum(['development', 'production', 'test']).meta({
			description: '`pnpm server:dev` sets this itself; it is only read from here by bare `pnpm script` / `pnpm preprocess` runs.',
			envExample: { include: 'omit', dev: { include: 'set', value: 'development' } },
		}),
		LOG_LEVEL_OVERRIDE: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional().meta({
			description: 'overrides the log level, which is otherwise info.',
			envExample: {
				dev: { description: 'overrides the log level, which is otherwise debug in development and test, info in production.' },
			},
		}),
		PUBLIC_GIT_SHA: z.string().min(1).prefault('unknown').meta({
			description: "baked into the image at build time from the Dockerfile's GIT_SHA/GIT_BRANCH build args, and reported on boot.",
			envExample: { include: 'omit' },
		}),
		PUBLIC_GIT_BRANCH: z.string().min(1).prefault('unknown').meta({
			description: 'see PUBLIC_GIT_SHA.',
			envExample: { include: 'omit' },
		}),

		QUERY_PARAM_AUTH_BYPASS: z.stringbool().optional().meta({
			description:
				'lets a request log in as an existing user with a `?login=<username>` query param, skipping discord oauth. Rejected when NODE_ENV=production.',
			envExample: { include: 'omit', dev: { include: 'commented' } },
		}),

		LOG_EXCLUDE_CONTEXT_PARAMS: z.string().default('').transform(val => new Set(val.split(',').map(s => s.trim()).filter(Boolean))).meta({
			description: 'comma-separated context params to leave out of rendered log lines. Does not affect exported logs.',
			envExample: { include: 'omit', dev: { include: 'commented' } },
		}),

		SECRETS_FILE: z.string().min(1).optional().meta({
			description:
				'the file credentials are read from. Defaults to ./.env.secrets when it exists; set this to read them from somewhere else (e.g. /run/secrets/slm-secrets, where a docker secret is mounted). A path that does not exist is an error.',
			envExample: { include: 'commented' },
		}),

		PUBLIC_REPO_URL: z.url().optional().meta({
			description: 'shown to users in the app. Set these to your fork if you run one.',
			envExample: { include: 'omit', dev: { include: 'commented' } },
		}),
		PUBLIC_ISSUES_URL: z.url().optional().meta({
			description: 'where the app points users who want to report a bug.',
			envExample: { include: 'omit', dev: { include: 'commented' } },
		}),
	},

	squadcalc: {
		PUBLIC_SQUADCALC_URL: NormedUrl.default('https://squadcalc.app').meta({
			description: 'the squadcalc instance the layer info popouts link out to. Only set it if you self-host squadcalc.',
		}),
	},

	otel: {
		OTEL_ENABLED: z.stringbool().default(true).meta({
			description: 'turn it off if nothing is listening on the endpoint below.',
		}),
		OTLP_COLLECTOR_ENDPOINT: NormedUrl.transform((url) => url.replace(/\/$/, '')).default('http://localhost:4318').meta({
			description: 'where the exporters send to. docker-compose points this at its own collector service.',
		}),
		OTEL_TRACE_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(1).meta({
			description: 'the fraction of traces sampled. 1 keeps everything.',
		}),
	},

	rbac: {
		SUPER_USERS: BigIntListSchema.meta({
			description:
				'comma-separated discord user ids granted every permission (e.g. 123456789012345678,987654321098765432). Set at least one, or nobody can administer the app. Every other role is configured from the settings page.',
			envExample: { include: 'set' },
		}),
		SUPER_ROLES: BigIntListSchema.meta({
			description: 'as SUPER_USERS, but discord role ids: everyone holding one of these roles is granted every permission.',
		}),
	},

	encryption: {
		// any string, hashed into the 32 bytes AES-256 needs
		SETTINGS_ENCRYPTION_KEY: z.string().min(1).transform(val => Crypto.createHash('sha256').update(val).digest()).meta({
			secret: true,
			description:
				"the key sensitive settings are encrypted at rest with (a server's RCON/SFTP passwords and server-agent token). Generate one with `openssl rand -base64 32`. Changing it makes already-encrypted connection secrets unreadable, so they have to be re-entered on the settings page.",
			envExample: {
				include: 'set',
				dev: {
					value: INSECURE_DEV_ENCRYPTION_KEY,
					description:
						'the key sensitive settings are encrypted at rest with. The value below is the public dev key; the app refuses to start with it when NODE_ENV=production. Generate a real one with `openssl rand -base64 32`.',
				},
			},
		}),
	},

	db: {
		DB_PATH: z.string().min(1).prefault('./data/db.sqlite3').meta({
			description: 'the main sqlite database. -wal and -shm files are created alongside it, so mount the directory, not the file.',
		}),
		DB_AUTOMIGRATE: z.stringbool().default(true).meta({
			description:
				'applies pending migrations at boot. Turn it off to run them yourself (`pnpm db:migrate:prod`); the app then refuses to start against a database that is behind.',
			envExample: {
				dev: {
					description:
						'applies pending migrations at boot. Turn it off to run them yourself (`pnpm db:migrate`); the app then refuses to start against a database that is behind.',
				},
			},
		}),
	},

	// a checkout has nothing worth backing up, so none of this shows up in the dev example
	backups: {
		AUTOMATIC_BACKUPS_PERIODIC: HumanTime.optional().meta({
			description:
				'how often to back up the main db, as a duration (e.g. 72h). Unset disables automatic backups, including the event-history prune that runs alongside them.',
			envExample: { dev: { include: 'omit' } },
		}),
		BACKUPS_DIR: z.string().min(1).prefault('./data/backups').meta({
			description: 'where backups are written locally.',
			envExample: { dev: { include: 'omit' } },
		}),
		BACKUPS_RETAIN_COUNT: ParsedIntSchema.pipe(z.number().min(0)).default(10).meta({
			description:
				'how many backups to keep, locally and on the sftp target. 0 keeps all of them. Periodic and pre-migration backups share this one window; the most recent pre-migration backup is always kept, however old.',
			envExample: { dev: { include: 'omit' } },
		}),

		EVENT_HISTORY_RETENTION_PERIOD: HumanTime.optional().meta({
			description:
				'server events from matches that ended longer ago than this duration (e.g. 90d) are deleted before each backup is taken. The most recent matches are always kept. Unset disables pruning.',
			envExample: { dev: { include: 'omit' } },
		}),

		BACKUP_SFTP_HOST: z.string().min(1).optional().meta({
			description:
				'an sftp target each backup is uploaded to after it is written locally. Setting this host enables the upload; a password or a private key is also required.',
			envExample: { dev: { include: 'omit' } },
		}),
		BACKUP_SFTP_PORT: ParsedIntSchema.default(22).meta({
			description: 'see BACKUP_SFTP_HOST.',
			envExample: { dev: { include: 'omit' } },
		}),
		BACKUP_SFTP_USERNAME: z.string().min(1).optional().meta({
			description: 'see BACKUP_SFTP_HOST.',
			envExample: { dev: { include: 'omit' } },
		}),
		BACKUP_SFTP_PASSWORD: z.string().min(1).optional().meta({
			secret: true,
			description: 'see BACKUP_SFTP_HOST. Either this or BACKUP_SFTP_PRIVATE_KEY_PATH is required once a host is set.',
			envExample: { dev: { include: 'omit' } },
		}),
		BACKUP_SFTP_PRIVATE_KEY_PATH: z.string().min(1).optional().meta({
			description: 'see BACKUP_SFTP_HOST. Either this or BACKUP_SFTP_PASSWORD is required once a host is set.',
			envExample: { dev: { include: 'omit' } },
		}),
		BACKUP_SFTP_PRIVATE_KEY_PASSPHRASE: z.string().min(1).optional().meta({
			secret: true,
			description: 'only needed if the key at BACKUP_SFTP_PRIVATE_KEY_PATH is encrypted.',
			envExample: { dev: { include: 'omit' } },
		}),
		BACKUP_SFTP_DIR: z.string().min(1).prefault('.').meta({
			description: 'the remote directory backups are written to. Created if it does not exist.',
			envExample: { dev: { include: 'omit' } },
		}),
	},

	discord: {
		DISCORD_ENABLED: z.stringbool().default(true).meta({
			description:
				'disables the discord integration entirely (no bot login, no guild fetches). The integration tests and the emulator run with it off; the other DISCORD_* vars still need dummy values.',
			envExample: { include: 'omit', dev: { include: 'commented' } },
		}),
		DISCORD_CLIENT_ID: z.string().min(1).meta({
			description: 'from the discord app SLM logs users in with. See the README for how to set that app up.',
		}),
		DISCORD_CLIENT_SECRET: z.string().min(1).meta({
			secret: true,
			description: "the discord app's oauth2 client secret.",
		}),
		DISCORD_BOT_TOKEN: z.string().min(1).meta({
			secret: true,
			description: 'the bot token of the same discord app. The bot has to be installed on the guild DISCORD_HOME_GUILD_ID names.',
		}),
		DISCORD_HOME_GUILD_ID: ParsedBigIntSchema.meta({
			description: "the guild SLM resolves users and roles against, i.e. your org's discord server.",
		}),
	},

	httpServer: {
		PORT: ParsedIntSchema.default(3000).meta({
			description: 'the port the app listens on. Put your reverse proxy in front of it and point ORIGIN at that.',
			envExample: { dev: { description: 'the port the app listens on. The client is served separately in development, see CLIENT_PORT.' } },
		}),
		HOST: z.string().prefault('127.0.0.1').meta({
			description: 'the interface the app binds to. The image already sets 0.0.0.0, since loopback inside a container is unreachable.',
			envExample: { dev: { description: 'the interface the app binds to.' } },
		}),
		CLIENT_PORT: ParsedIntSchema.default(5173).meta({
			description: "the vite dev server's port. Move it to run a second instance beside a running one; ORIGIN has to move with it.",
			envExample: { include: 'omit', dev: { include: 'commented' } },
		}),
		ORIGIN: NormedUrl.default('http://localhost:3000').meta({
			description:
				"the publicly addressable url the app is reached at, from a browser's point of view. The default below only holds if the app is reached directly on PORT, with nothing in front of it. The discord oauth callback is built from this, so it also has to match a redirect uri registered on the discord app.",
			// written out uncommented in both files, showing the url that environment is actually reached at, so
			// that changing it is an edit rather than something you have to know to uncomment
			envExample: {
				include: 'set',
				dev: {
					value: 'http://localhost:5173',
					description:
						"the url the app is reached at, from a browser's point of view. In development that is the vite dev server (CLIENT_PORT), which serves the client, not the app's own port. The discord oauth callback is built from this, so it also has to match a redirect uri registered on the discord app.",
				},
			},
		}),
	},

	layers: {
		LAYERS_VERSION: PathSegment.default('@latest').meta({
			description:
				'@latest resolves to the highest version whose artifacts are present. Pinning a version no searched directory has is an error.',
		}),
		LAYERS_DIR: z.string().min(1).optional().meta({
			description:
				'an extra directory to search for layer artifacts, ahead of ./data and the assets/layers the image ships. Only needed when the artifacts live outside the data mount.',
		}),
	},

	// only `pnpm preprocess` reads these, so they stay out of the deployment example
	preprocess: {
		SPREADSHEET_ID: z.string().prefault('1UXEgkUMBxhmYyEkaMSUd1Ko_I7s--7krCdyshZ076pU').meta({
			description: "OWI's layer spreadsheet. Only used for layer sizes at the moment.",
			envExample: { include: 'omit', dev: { include: 'commented' } },
		}),
		SPREADSHEET_MAP_LAYERS_GID: ParsedIntSchema.default(1212962563).meta({
			description: 'the sheet within SPREADSHEET_ID the layers are read from.',
			envExample: { include: 'omit', dev: { include: 'commented' } },
		}),
		EXTRA_COLS_CSV_PATH: z.string().prefault(path.join(Paths.DATA, 'layers_v{{LAYERS_VERSION}}.csv')).meta({
			description: 'the csv preprocess ingests, and where a build takes its version from. Too big to ship, so it stays in ./data.',
			envExample: { include: 'omit', dev: { include: 'commented' } },
		}),
		LAYERS_OUTPUT_DIR: z.string().min(1).prefault(Paths.LAYERS).meta({
			description: 'where preprocess writes the pair it builds. Defaults to the directory that ships with the image.',
			envExample: { include: 'omit', dev: { include: 'commented' } },
		}),
		LAYER_DB_CONFIG_PATH: z.string().prefault('./layer-db.json').meta({
			description:
				'defines the extra columns to ingest into the layer table. Read only by preprocess, which bakes the definitions into layer-data.json.',
			envExample: { include: 'omit', dev: { include: 'commented' } },
		}),
	},

	battlemetrics: {
		BM_HOST: z.url().prefault('https://api.battlemetrics.com').meta({
			description: 'the battlemetrics api.',
		}),

		BM_PAT: z.string().meta({
			secret: true,
			description: `battlemetrics API token. It needs these permissions:
- player flags (add/remove; it does not need to create new ones)
- player notes (read & create)
- rcon (read)
Leave it empty if you have no battlemetrics org: the app boots without it, and the features that read it fail.`,
		}),

		BM_ORG_ID: z.string().meta({
			description: 'the battlemetrics organization BM_PAT belongs to. Player flags are filtered to this org.',
		}),
	},
} satisfies { [key: string]: Record<string, z.ZodType> }

// section headers in the example env files. A group whose vars are all omitted never shows up.
export const groupMeta: Record<keyof typeof groups, { title: string; description?: string }> = {
	general: { title: 'General' },
	squadcalc: { title: 'Squadcalc' },
	otel: {
		title: 'Telemetry',
		description:
			'the app exports traces, metrics and logs over OTLP. docker-compose runs a grafana/otel-lgtm collector next to it, which serves the dashboards.',
	},
	rbac: { title: 'Permissions' },
	encryption: { title: 'Encryption' },
	db: { title: 'Database' },
	backups: { title: 'Backups' },
	discord: {
		title: 'Discord',
		description: 'SLM authenticates users through a discord app you own. The README walks through creating one.',
	},
	httpServer: { title: 'HTTP server' },
	layers: {
		title: 'Layers',
		description:
			'the app ships with a complete set of layer artifacts and boots without any of these set. See the README for how a version is resolved.',
	},
	preprocess: {
		title: 'Preprocess',
		description: 'only read by `pnpm preprocess`, which builds a layer artifact pair. The app itself never reads them.',
	},
	battlemetrics: { title: 'Battlemetrics' },
}

export function isSecret(schema: z.ZodType): boolean {
	return schema.meta()?.secret === true
}

export function entries(): [string, z.ZodType][] {
	return Object.values(groups).flatMap(group => Object.entries(group as Record<string, z.ZodType>))
}

export const DEFAULT_SECRETS_PATH = path.join(Paths.PROJECT_ROOT, '.env.secrets')

let rawEnv!: Record<string, string | undefined>

// the secrets that arrived as environment variables rather than from the secrets file, which is supported but
// worth a word in production. Read after ensureEnvSetup, once there is a logger to say it with.
let secretsFromEnvironment: string[] = []

export function getSecretsFromEnvironment(): string[] {
	return secretsFromEnvironment
}

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

// the raw, unparsed value of a var, for the callers that only want to know whether it is set at all. Secrets
// are not in process.env to be checked directly (see ensureEnvSetup), so this is the only way to ask.
export function rawVar(key: string): string | undefined {
	return rawEnv[key]
}

// injects a var into the already-frozen rawEnv after ensureEnvSetup has run, so that a value decided at
// runtime is visible to env builders. Clears any cached parse so the next build picks it up.
export function injectRawVar(key: string, value: string) {
	rawEnv[key] = value
	parsedProperties.delete(key)
}

const buildForValidation = getEnvBuilder({
	NODE_ENV: groups.general.NODE_ENV,
	QUERY_PARAM_AUTH_BYPASS: groups.general.QUERY_PARAM_AUTH_BYPASS,
})

// The default path is a convention rather than a requirement: a checkout and the test harness pass their
// secrets in the environment and have no file. A path asked for explicitly does have to be there, since
// booting without the secrets someone pointed us at is never what they meant.
function resolveSecretsFile(): { filePath: string; explicit: boolean } {
	const explicit = Cli.options?.secretsFile ?? process.env.SECRETS_FILE
	return explicit ? { filePath: explicit, explicit: true } : { filePath: DEFAULT_SECRETS_PATH, explicit: false }
}

function readSecretsFile(): Record<string, string> {
	const { filePath, explicit } = resolveSecretsFile()
	let contents: string
	try {
		contents = fs.readFileSync(filePath, 'utf8')
	} catch (error) {
		if (!explicit && (error as NodeJS.ErrnoException).code === 'ENOENT') return {}
		throw new Error(`Could not read the secrets file at ${filePath}`, { cause: error })
	}
	return dotenv.parse(contents)
}

export function ensureEnvSetup() {
	if (setup) return
	// entrypoints which don't use the cli system (scripts) still get the default .env; --env-file only overrides the path
	dotenv.config({ path: Cli.options?.envFile })
	const secrets = readSecretsFile()
	rawEnv = {}
	secretsFromEnvironment = []
	for (const [key, schema] of entries()) {
		const fromFile = isSecret(schema) ? secrets[key] : undefined
		const value = fromFile ?? process.env[key]
		if (value) rawEnv[key] = value
		if (value && isSecret(schema) && fromFile === undefined) secretsFromEnvironment.push(key)
	}

	const toValidate = buildForValidation()
	if (toValidate.NODE_ENV === 'production' && toValidate.QUERY_PARAM_AUTH_BYPASS) {
		throw new Error('QUERY_PARAM_AUTH_BYPASS=true is not allowed in production')
	}
	if (toValidate.NODE_ENV === 'production' && rawEnv.SETTINGS_ENCRYPTION_KEY === INSECURE_DEV_ENCRYPTION_KEY) {
		throw new Error(
			'SETTINGS_ENCRYPTION_KEY is the development key .env.example.dev ships, which is public. Generate a real one with `openssl rand -base64 32`.',
		)
	}

	setup = true
}
