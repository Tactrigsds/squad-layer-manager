import * as dotenv from 'dotenv'
import * as Crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import * as Paths from '../../paths.ts'
import * as ZodUtils from '../lib/zod-utils.ts'
import { z } from '../lib/zod.ts'
import * as Cli from '../systems/cli.server.ts'

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
		// the var holds a credential: it is read from the secrets file or directory (see readSecrets) and written
		// to .env.secrets.example rather than .env.example. docs/installing.md covers why.
		secret?: true
		// the var moved elsewhere. Still read, so a value can be carried over once (see legacyIntegrationSettings),
		// and reported at boot with this note; left out of the example files.
		deprecationNote?: string
	}
}

// the shortest SETTINGS_ENCRYPTION_KEY production accepts. `openssl rand -base64 32` gives 44; a hand-typed
// passphrase below this is brute-forceable against a leaked database, since the derivation is a plain sha256.
export const MIN_ENCRYPTION_KEY_LENGTH = 16

// The key .env.example.dev ships, so a checkout boots without a key-generation step. It says what it is,
// where a random-looking string would not; the production server refuses to start with it (see assertEncryptionKeyIsStrong).
export const INSECURE_DEV_ENCRYPTION_KEY = 'A_VERY_INSECURE_ENCRYPTION_KEY'

// comma-separated list of Discord snowflake ids parsed to bigints (e.g. SUPER_USERS="123,456")
const BigIntListSchema = z
	.string()
	.default('')
	.transform((val) =>
		val
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean)
			.map(BigInt),
	)

const MOVED_TO_SETTINGS =
	'now configured on the settings page, under Integrations. The value here was carried over into the settings on the first boot after upgrading, and is ignored from then on.'

// named rather than inlined into BM_HOST because the DEMO conflict check asks whether that is where we point
const BATTLEMETRICS_API = 'https://api.battlemetrics.com'
const SQUADBROWSER_API = 'https://api.squadbrowser.app'
const STEAM_API = 'https://api.steampowered.com'

export const groups = {
	demo: {
		DEMO: z
			.stringbool()
			.default(false)
			.meta({
				description:
					'runs the app as a throwaway demo: every other variable below gets a working default, the discord integration is off, anyone can sign in as any username from a form on the front page, and a fresh database is seeded with example data. Plugins cannot be installed from a url. Everything it holds is disposable, and it refuses to boot alongside anything that is not.',
				envExample: { include: 'commented' },
			}),
	},

	general: {
		LOCAL_ADMIN_LISTS_DIR: z
			.string()
			.min(1)
			.prefault(Paths.DATA)
			.meta({
				description:
					"the directory a 'Local file' admin list source must be in. Anyone who can edit the admin lists can point one at a file, so files outside this directory are refused.",
				envExample: { include: 'commented' },
			}),
		NODE_ENV: z.enum(['development', 'production', 'test']).meta({
			description: '`pnpm server:dev` sets this itself; it is only read from here by bare `pnpm script` / `pnpm preprocess` runs.',
			envExample: { include: 'omit', dev: { include: 'set', value: 'development' } },
		}),
		LOG_LEVEL_OVERRIDE: z
			.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
			.optional()
			.meta({
				description: 'overrides the log level, which is otherwise info.',
				envExample: {
					dev: { description: 'overrides the log level, which is otherwise debug in development and test, info in production.' },
				},
			}),
		PUBLIC_GIT_SHA: z
			.string()
			.min(1)
			.prefault('unknown')
			.meta({
				description: "baked into the image at build time from the Dockerfile's GIT_SHA/GIT_BRANCH build args, and reported on boot.",
				envExample: { include: 'omit' },
			}),
		PUBLIC_GIT_BRANCH: z
			.string()
			.min(1)
			.prefault('unknown')
			.meta({
				description: 'see PUBLIC_GIT_SHA.',
				envExample: { include: 'omit' },
			}),

		QUERY_PARAM_AUTH_BYPASS: z
			.stringbool()
			.optional()
			.meta({
				description:
					'turns discord auth off: a `?login=<username>` query param logs in as that existing user, and everyone else gets a form on the front page asking for a name. Rejected when NODE_ENV=production unless DEMO is set.',
				envExample: { include: 'omit', dev: { include: 'commented' } },
			}),

		LOG_EXCLUDE_CONTEXT_PARAMS: z
			.string()
			.default('')
			.transform(
				(val) =>
					new Set(
						val
							.split(',')
							.map((s) => s.trim())
							.filter(Boolean),
					),
			)
			.meta({
				description: 'comma-separated context params to leave out of rendered log lines. Does not affect exported logs.',
				envExample: { include: 'omit', dev: { include: 'commented' } },
			}),

		RCON_POLL_INTERVAL_SCALE: z.coerce
			.number()
			.positive()
			.default(1)
			.meta({
				description:
					'multiplies the intervals at which SLM polls each game server over RCON: the current and next layer every 5s, server info every 10s and the roster every 5s. A cached read of one of these is refetched once it is older than its interval. The integration tests set it below 1 so that changes on the emulated server reach the app sooner.',
				envExample: { include: 'omit' },
			}),

		SECRETS_FILE: z
			.string()
			.min(1)
			.optional()
			.meta({
				description:
					'the file credentials are read from. Defaults to ./.env.secrets when it exists; set this to read them from somewhere else (e.g. /run/secrets/slm-secrets, where a docker secret is mounted). A path that does not exist is an error.',
				envExample: { include: 'commented' },
			}),

		SECRETS_DIR: z
			.string()
			.min(1)
			.optional()
			.meta({
				description:
					'a directory holding one file per credential, named after the variable (e.g. /run/secrets/DISCORD_BOT_TOKEN), which is how docker, podman, kubernetes and systemd mount individual secrets. A trailing newline is dropped. A file found here wins over the same variable in SECRETS_FILE; a directory that does not exist is an error.',
				envExample: { include: 'commented', dev: { include: 'omit' } },
			}),

		PUBLIC_REPO_URL: z
			.url()
			.optional()
			.meta({
				description: 'shown to users in the app. Set these to your fork if you run one.',
				envExample: { include: 'omit', dev: { include: 'commented' } },
			}),
		PUBLIC_ISSUES_URL: z
			.url()
			.optional()
			.meta({
				description: "where the app points users who want to report a bug. Defaults to this project's own issue tracker.",
				envExample: { include: 'omit', dev: { include: 'commented' } },
			}),
		PUBLIC_DOCS_URL: ZodUtils.NormedUrl.optional().meta({
			description:
				"the root of the documentation site the app links to. The app picks the folder for the version it runs from the site's versions.json, so the site has to be built the way this project's is. Defaults to this project's documentation.",
			envExample: { include: 'omit', dev: { include: 'commented' } },
		}),
		PUBLIC_HELP_URL: z
			.url()
			.optional()
			.meta({
				description:
					"where the app points users who want help, e.g. your own documentation or your community's discord. Defaults to this project's discord.",
				envExample: { include: 'commented', dev: { include: 'commented' } },
			}),
	},

	squadcalc: {
		PUBLIC_SQUADCALC_URL: ZodUtils.NormedUrl.default('https://squadcalc.app').meta({
			description: 'the squadcalc instance the layer info popouts link out to. Only set it if you self-host squadcalc.',
		}),
	},

	otel: {
		OTEL_ENABLED: z.stringbool().default(true).meta({
			description: 'turn it off if nothing is listening on the endpoint below.',
		}),
		OTLP_COLLECTOR_ENDPOINT: ZodUtils.NormedUrl.transform((url) => url.replace(/\/$/, ''))
			.default('http://localhost:4318')
			.meta({
				description: 'where the exporters send to. docker-compose points this at its own collector service.',
			}),
		OTEL_METRIC_EXPORT_INTERVAL: z.coerce
			.number()
			.int()
			.min(1000)
			.default(60_000)
			.meta({
				description:
					'how often metrics are exported, in milliseconds. This is the resolution of every gauge on the dashboards: lowering it makes short-lived state (a switch queue that drains in seconds) visible at the cost of more samples to store.',
				envExample: { include: 'commented' },
			}),
		OTEL_TRACE_SAMPLE_RATIO: z.coerce
			.number()
			.min(0)
			.max(1)
			.optional()
			.meta({
				description:
					'the fraction of traces sampled. 1 keeps everything, which is what unset means outside production; in production unset means 0.25, because most spans are high-frequency polling and the trace store pays to keep all of them. Set it to 1 there when you need full fidelity for a while.',
				envExample: { include: 'commented' },
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
		SETTINGS_ENCRYPTION_KEY: z
			.string()
			.min(1)
			.transform((val) => Crypto.createHash('sha256').update(val).digest())
			.meta({
				secret: true,
				description:
					"the key sensitive settings are encrypted at rest with (a server's RCON/SFTP passwords and server-agent token). Generate one with `openssl rand -base64 32`; production refuses one shorter than 16 characters. To rotate it, move the current value to SETTINGS_ENCRYPTION_KEY_PREVIOUS and put the new one here.",
				envExample: {
					include: 'set',
					dev: {
						value: INSECURE_DEV_ENCRYPTION_KEY,
						description:
							'the key sensitive settings are encrypted at rest with. The value below is the public dev key; the app refuses to start with it when NODE_ENV=production. Generate a real one with `openssl rand -base64 32`.',
					},
				},
			}),
		SETTINGS_ENCRYPTION_KEY_PREVIOUS: z
			.string()
			.min(1)
			.transform((val) => Crypto.createHash('sha256').update(val).digest())
			.optional()
			.meta({
				secret: true,
				description:
					'the key SETTINGS_ENCRYPTION_KEY replaced. Anything still encrypted with it is re-encrypted with the current key on the next boot, after which this can be removed.',
				envExample: { include: 'commented', dev: { include: 'omit' } },
			}),
	},

	plugins: {
		CONTROL_SOCKET: z
			.string()
			.prefault(path.join(Paths.DATA, 'control.sock'))
			.meta({
				description:
					'unix socket for operating the running app from inside its container (see systems/control-socket.server.ts): ' +
					'reloading plugins a deployment just copied in, or announcing a restart. Mode 0600, so only the user SLM runs as and root can reach it. Empty disables it.',
			}),
		PLUGINS_DIR: z.string().min(1).prefault(path.join(Paths.DATA, 'plugins')).meta({
			description:
				'where packaged plugins live, one directory each. Under ./data by default, which a deployment already mounts, so plugins survive an image upgrade and can be dropped in by hand.',
		}),
	},

	db: {
		DB_PATH: z.string().min(1).prefault('./data/db.sqlite3').meta({
			description: 'the main sqlite database. -wal and -shm files are created alongside it, so mount the directory, not the file.',
		}),
		DB_AUTOMIGRATE: z
			.stringbool()
			.default(true)
			.meta({
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
		AUTOMATIC_BACKUPS_PERIODIC: ZodUtils.HumanTime.optional().meta({
			description:
				'how often to back up the main db, as a duration (e.g. 72h). Unset disables automatic backups, including the event-history prune that runs alongside them.',
			envExample: { dev: { include: 'omit' } },
		}),
		BACKUPS_DIR: z
			.string()
			.min(1)
			.prefault('./data/backups')
			.meta({
				description: 'where backups are written locally.',
				envExample: { dev: { include: 'omit' } },
			}),
		BACKUPS_RETAIN_COUNT: ZodUtils.ParsedIntSchema.pipe(z.number().min(0))
			.default(10)
			.meta({
				description:
					'how many backups to keep, locally and on the sftp target. 0 keeps all of them. Periodic and pre-migration backups share this one window; the most recent pre-migration backup is always kept, however old.',
				envExample: { dev: { include: 'omit' } },
			}),

		EVENT_ARCHIVE_MIN_HOT_MATCHES: ZodUtils.ParsedIntSchema.pipe(z.number().min(0))
			.default(100)
			.meta({
				description:
					'how many of the most recent matches on each server are kept in the hot events table regardless of age. A floor on top of EVENT_ARCHIVE_WINDOW: compacted matches read back identically, so this only trades a little read latency on older matches for a smaller hot table.',
				envExample: { dev: { include: 'omit' } },
			}),

		EVENT_ARCHIVE_INTERVAL: ZodUtils.HumanTime.default(() => ZodUtils.parseHumanTime('1h')).meta({
			description: 'how often matches that have left the archive window are compacted. The first pass runs one interval after boot.',
			envExample: { dev: { include: 'omit' } },
		}),

		EVENT_ARCHIVE_WINDOW: ZodUtils.HumanTime.default(() => ZodUtils.parseHumanTime('48h')).meta({
			description:
				'how long a finished match stays in the hot events table before its events are compacted into a single compressed row. Compacted matches read back identically, a fraction of a millisecond slower, and stay searchable through the player event index. The most recent matches on each server are kept hot regardless of this setting.',
			envExample: { dev: { include: 'omit' } },
		}),

		BACKUP_SFTP_HOST: z
			.string()
			.min(1)
			.optional()
			.meta({
				description:
					'an sftp target each backup is uploaded to after it is written locally. Setting this host enables the upload; a password or a private key is also required.',
				envExample: { dev: { include: 'omit' } },
			}),
		BACKUP_SFTP_PORT: ZodUtils.ParsedIntSchema.default(22).meta({
			description: 'see BACKUP_SFTP_HOST.',
			envExample: { dev: { include: 'omit' } },
		}),
		BACKUP_SFTP_USERNAME: z
			.string()
			.min(1)
			.optional()
			.meta({
				description: 'see BACKUP_SFTP_HOST.',
				envExample: { dev: { include: 'omit' } },
			}),
		BACKUP_SFTP_PASSWORD: z
			.string()
			.min(1)
			.optional()
			.meta({
				secret: true,
				description: 'see BACKUP_SFTP_HOST. Either this or BACKUP_SFTP_PRIVATE_KEY_PATH is required once a host is set.',
				envExample: { dev: { include: 'omit' } },
			}),
		BACKUP_SFTP_PRIVATE_KEY_PATH: z
			.string()
			.min(1)
			.optional()
			.meta({
				description: 'see BACKUP_SFTP_HOST. Either this or BACKUP_SFTP_PASSWORD is required once a host is set.',
				envExample: { dev: { include: 'omit' } },
			}),
		BACKUP_SFTP_PRIVATE_KEY_PASSPHRASE: z
			.string()
			.min(1)
			.optional()
			.meta({
				secret: true,
				description: 'only needed if the key at BACKUP_SFTP_PRIVATE_KEY_PATH is encrypted.',
				envExample: { dev: { include: 'omit' } },
			}),
		BACKUP_SFTP_DIR: z
			.string()
			.min(1)
			.prefault('.')
			.meta({
				description: 'the remote directory backups are written to. Created if it does not exist.',
				envExample: { dev: { include: 'omit' } },
			}),
	},

	discord: {
		DISCORD_ENABLED: z
			.stringbool()
			.default(true)
			.meta({
				description:
					'disables the discord integration entirely (no bot login, no guild fetches). The integration tests and the emulator run with it off; the other DISCORD_* vars still need dummy values.',
				envExample: { include: 'omit', dev: { include: 'commented' } },
			}),
		DISCORD_CLIENT_ID: z.string().min(1).meta({
			description: 'from the discord app SLM logs users in with.',
		}),
		DISCORD_CLIENT_SECRET: z.string().min(1).meta({
			secret: true,
			description: "the discord app's oauth2 client secret.",
		}),
		DISCORD_BOT_TOKEN: z.string().min(1).meta({
			secret: true,
			description: 'the bot token of the same discord app. The bot has to be installed on the guild DISCORD_HOME_GUILD_ID names.',
		}),
		DISCORD_HOME_GUILD_ID: ZodUtils.ParsedBigIntSchema.meta({
			description: "the guild SLM resolves users and roles against, i.e. your org's discord server.",
		}),
	},

	httpServer: {
		PORT: ZodUtils.ParsedIntSchema.default(3000).meta({
			description: 'the port the app listens on. Put your reverse proxy in front of it and point ORIGIN at that.',
			envExample: {
				dev: { description: 'the port the app listens on. The client is served separately in development, see CLIENT_PORT.' },
			},
		}),
		HOST: z
			.string()
			.prefault('127.0.0.1')
			.meta({
				description:
					'the interface the app binds to. The image already sets 0.0.0.0, since loopback inside a container is unreachable.',
				envExample: { dev: { description: 'the interface the app binds to.' } },
			}),
		CLIENT_PORT: ZodUtils.ParsedIntSchema.default(5173).meta({
			description: "the vite dev server's port. Move it to run a second instance beside a running one; ORIGIN has to move with it.",
			envExample: { include: 'omit', dev: { include: 'commented' } },
		}),
		ORIGIN: ZodUtils.NormedUrl.default('http://localhost:3000').meta({
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
		LAYERS_VERSION: ZodUtils.PathSegment.default('@latest').meta({
			description:
				'@latest resolves to the highest version whose artifacts are present. Pinning a version no searched directory has is an error.',
		}),
		LAYERS_DIR: z.string().min(1).optional().meta({
			description:
				'an extra directory to search for layer artifacts, ahead of ./data and the assets/layers the image ships. Only needed when the artifacts live outside the data mount.',
		}),
		CACHE_LAYER_ARTIFACT: z
			.stringbool()
			.optional()
			.meta({
				description:
					'whether browsers keep the layer artifact in OPFS between page loads. On unless NODE_ENV is test, where every e2e test gets a fresh profile nothing reads back; the e2e tests that cover the cache set it.',
				envExample: { include: 'omit' },
			}),
	},

	// only `pnpm preprocess` reads these, so they stay out of the deployment example
	preprocess: {
		EXTRA_COLS_CSV_PATH: z
			.string()
			.prefault(path.join(Paths.DATA, 'layers_v{{LAYERS_VERSION}}.csv'))
			.meta({
				description: 'the csv preprocess ingests, and where a build takes its version from. Too big to ship, so it stays in ./data.',
				envExample: { include: 'omit', dev: { include: 'commented' } },
			}),
		LAYERS_OUTPUT_DIR: z
			.string()
			.min(1)
			.prefault(Paths.LAYERS)
			.meta({
				description: 'where preprocess writes the pair it builds. Defaults to the directory that ships with the image.',
				envExample: { include: 'omit', dev: { include: 'commented' } },
			}),
		LAYER_DB_CONFIG_PATH: z
			.string()
			.prefault('./layer-db.json')
			.meta({
				description:
					'defines the extra columns to ingest into the layer table. Read only by preprocess, which bakes the definitions into layer-data.json.',
				envExample: { include: 'omit', dev: { include: 'commented' } },
			}),
	},

	// The credentials and switches of these three moved to the settings page (SETTINGS.IntegrationsSchema). The
	// variables are still read so an upgrade carries them over once, and the hosts stay: only a dev instance or a
	// test points one at a stub.
	battlemetrics: {
		BM_ENABLED: z
			.stringbool()
			.optional()
			.meta({
				deprecationNote: MOVED_TO_SETTINGS,
				description: 'whether the battlemetrics integration is on.',
				envExample: { include: 'omit' },
			}),

		BM_HOST: z.url().prefault(BATTLEMETRICS_API).meta({
			description: 'the battlemetrics api.',
		}),

		BM_PAT: z
			.string()
			.min(1)
			.optional()
			.meta({
				secret: true,
				deprecationNote: MOVED_TO_SETTINGS,
				description: 'a battlemetrics API token.',
				envExample: { include: 'omit' },
			}),

		BM_ORG_ID: z
			.string()
			.min(1)
			.optional()
			.meta({
				deprecationNote: MOVED_TO_SETTINGS,
				description: 'the battlemetrics organization BM_PAT belongs to.',
				envExample: { include: 'omit' },
			}),
	},

	squadbrowser: {
		SQUADBROWSER_ENABLED: z
			.stringbool()
			.optional()
			.meta({
				deprecationNote: MOVED_TO_SETTINGS,
				description: 'whether the squad browser integration is on.',
				envExample: { include: 'omit' },
			}),

		SQUADBROWSER_HOST: z.url().prefault(SQUADBROWSER_API).meta({
			description: 'the squad browser api.',
		}),

		SQUADBROWSER_API_KEY: z
			.string()
			.min(1)
			.optional()
			.meta({
				secret: true,
				deprecationNote: MOVED_TO_SETTINGS,
				description: 'a squad browser API key.',
				envExample: { include: 'omit' },
			}),
	},

	steam: {
		STEAM_ENABLED: z
			.stringbool()
			.optional()
			.meta({
				deprecationNote: MOVED_TO_SETTINGS,
				description: 'whether the steam integration is on.',
				envExample: { include: 'omit' },
			}),

		STEAM_HOST: z.url().prefault(STEAM_API).meta({
			description: 'the steam web api.',
		}),

		STEAM_API_KEY: z
			.string()
			.min(1)
			.optional()
			.meta({
				secret: true,
				deprecationNote: MOVED_TO_SETTINGS,
				description: 'a steam web api key.',
				envExample: { include: 'omit' },
			}),
	},
} satisfies { [key: string]: Record<string, z.ZodType> }

// section headers in the example env files. A group whose vars are all omitted never shows up.
export const groupMeta: Record<keyof typeof groups, { title: string; description?: string }> = {
	demo: {
		title: 'Demo',
		description: 'a demo instance needs no configuration at all: set DEMO and leave every other variable below unset.',
	},
	general: { title: 'General' },
	squadcalc: { title: 'Squadcalc' },
	otel: {
		title: 'Telemetry',
		description:
			'the app exports traces, metrics and logs over OTLP. docker-compose runs an OpenTelemetry collector next to it, which routes each signal to its own store, and a Grafana that serves the dashboards.',
	},
	rbac: { title: 'Permissions' },
	encryption: { title: 'Encryption' },
	db: { title: 'Database' },
	plugins: { title: 'Plugins' },
	backups: { title: 'Backups' },
	discord: {
		title: 'Discord',
		description: 'SLM authenticates users through a discord app you own.',
	},
	httpServer: { title: 'HTTP server' },
	layers: {
		title: 'Layers',
		description: 'the app ships with a complete set of layer artifacts and boots without any of these set.',
	},
	preprocess: {
		title: 'Preprocess',
		description: 'only read by `pnpm preprocess`, which builds a layer artifact pair. The app itself never reads them.',
	},
	battlemetrics: { title: 'Battlemetrics' },
	squadbrowser: { title: 'Squad Browser' },
	steam: { title: 'Steam' },
}

export function isSecret(schema: z.ZodType): boolean {
	return schema.meta()?.secret === true
}

// the deprecated vars this environment still sets, with the note each carries, for the boot log
export function deprecatedVarsSet(): { key: string; note: string }[] {
	const out: { key: string; note: string }[] = []
	for (const [key, schema] of entries()) {
		const note = schema.meta()?.deprecationNote
		if (note && rawEnv[key] !== undefined) out.push({ key, note })
	}
	return out
}

// The integration settings an environment from before 1.10 describes, in the shape SETTINGS.IntegrationsSchema
// parses, or undefined when it sets none of those vars. A switch left unset reads as on: the token decides.
export function legacyIntegrationSettings(): Record<string, unknown> | undefined {
	const keys = ['BM_ENABLED', 'BM_PAT', 'BM_ORG_ID', 'SQUADBROWSER_ENABLED', 'SQUADBROWSER_API_KEY', 'STEAM_ENABLED', 'STEAM_API_KEY']
	if (!keys.some((key) => rawEnv[key] !== undefined)) return undefined
	const on = (key: string) => (rawEnv[key] === undefined ? true : (z.stringbool().safeParse(rawEnv[key]).data ?? true))
	return {
		battlemetrics: { enabled: on('BM_ENABLED'), token: rawEnv.BM_PAT ?? '', orgId: rawEnv.BM_ORG_ID ?? '' },
		squadBrowser: { enabled: on('SQUADBROWSER_ENABLED'), token: rawEnv.SQUADBROWSER_API_KEY ?? '' },
		steam: { enabled: on('STEAM_ENABLED'), token: rawEnv.STEAM_API_KEY ?? '' },
	}
}

export function entries(): [string, z.ZodType][] {
	return Object.values(groups).flatMap((group) => Object.entries(group as Record<string, z.ZodType>))
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

// What DEMO fills in for a variable left unset, so that it is the only one anybody has to set. Only the ones
// that would otherwise stop the boot or reach for something that isn't there: everything else already has a
// default that suits a demo. The encryption key is the public one, and QUERY_PARAM_AUTH_BYPASS is what turns
// off discord auth (see the no-auth login portal in fastify.server.ts).
const DEMO_DEFAULTS: Record<string, string> = {
	NODE_ENV: 'production',
	QUERY_PARAM_AUTH_BYPASS: 'true',
	SETTINGS_ENCRYPTION_KEY: INSECURE_DEV_ENCRYPTION_KEY,
	OTEL_ENABLED: 'false',
	DISCORD_ENABLED: 'false',
	DISCORD_CLIENT_ID: 'demo',
	DISCORD_CLIENT_SECRET: 'demo',
	DISCORD_BOT_TOKEN: 'demo',
	DISCORD_HOME_GUILD_ID: '0',
}

// DEMO fills a gap but never wins an argument, so a variable it owns, set to something that contradicts it, is
// refused rather than quietly overridden or quietly obeyed. Both ways that goes wrong are silent: credentials
// DEMO cannot honour leave an instance that looks authenticated while the login portal signs anyone in as
// anyone, and QUERY_PARAM_AUTH_BYPASS=false registers an oauth flow against the placeholder credentials DEMO
// made up, which nobody can log in through. Neither trips the production guards below, since DEMO skips them.
//
// What is refused is a variable that still reaches something, not one that merely holds a value: a dev
// instance and the test harness both hand over inert credentials alongside a stub to spend them on, and that
// is a demo rather than a contradiction of one.
const discordIsTurnedOff = () => groups.discord.DISCORD_ENABLED.safeParse(rawEnv.DISCORD_ENABLED).data === false
const battlemetricsIsAStub = () => (rawEnv.BM_HOST ?? BATTLEMETRICS_API) !== BATTLEMETRICS_API
const squadbrowserIsAStub = () => (rawEnv.SQUADBROWSER_HOST ?? SQUADBROWSER_API) !== SQUADBROWSER_API
const steamIsAStub = () => (rawEnv.STEAM_HOST ?? STEAM_API) !== STEAM_API

const DEMO_CONFLICTS: { keys: string[]; conflicts: (value: string) => boolean; reason: string }[] = [
	{
		keys: ['QUERY_PARAM_AUTH_BYPASS'],
		conflicts: (value) => groups.general.QUERY_PARAM_AUTH_BYPASS.safeParse(value).data === false,
		reason: 'a demo has no discord app to authenticate against, so turning the no-auth login portal off leaves nobody able to log in',
	},
	{
		keys: ['DISCORD_ENABLED'],
		conflicts: (value) => groups.discord.DISCORD_ENABLED.safeParse(value).data === true,
		reason: 'a demo runs with the discord integration off',
	},
	{
		keys: ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN', 'DISCORD_HOME_GUILD_ID'],
		conflicts: () => !discordIsTurnedOff(),
		reason:
			'a demo never registers the oauth flow, so credentials for an integration still switched on go unused while anyone can sign in as anyone. DISCORD_ENABLED=false says they are inert and is accepted',
	},
	{
		keys: ['BM_PAT'],
		conflicts: () => !battlemetricsIsAStub(),
		reason:
			'a demo would write player flags and notes to the real battlemetrics org the token belongs to. A BM_HOST pointed at a stub is accepted',
	},
	{
		keys: ['BM_ENABLED'],
		conflicts: (value) => groups.battlemetrics.BM_ENABLED.safeParse(value).data === true && !battlemetricsIsAStub(),
		reason: 'a demo has no battlemetrics org to read or write. A BM_HOST pointed at a stub is accepted',
	},
	{
		keys: ['SQUADBROWSER_API_KEY'],
		conflicts: () => !squadbrowserIsAStub(),
		reason:
			"a demo's servers are made up, so the key would be spent looking up names the real squad browser api has never seen. A SQUADBROWSER_HOST pointed at a stub is accepted",
	},
	{
		keys: ['SQUADBROWSER_ENABLED'],
		conflicts: (value) => groups.squadbrowser.SQUADBROWSER_ENABLED.safeParse(value).data === true && !squadbrowserIsAStub(),
		reason: 'a demo has no real server to hand anyone a join link for. A SQUADBROWSER_HOST pointed at a stub is accepted',
	},
	{
		keys: ['STEAM_API_KEY'],
		conflicts: () => !steamIsAStub(),
		reason:
			"a demo's players are made up, so the key would be spent asking steam about accounts that were never on a server. A STEAM_HOST pointed at a stub is accepted",
	},
	{
		keys: ['STEAM_ENABLED'],
		conflicts: (value) => groups.steam.STEAM_ENABLED.safeParse(value).data === true && !steamIsAStub(),
		reason: 'a demo has no real server to hand anyone a join link for. A STEAM_HOST pointed at a stub is accepted',
	},
]

function assertDemoIsUncontradicted() {
	const contradictions = DEMO_CONFLICTS.flatMap(({ keys, conflicts, reason }) => {
		const set = keys.filter((key) => rawEnv[key] !== undefined && conflicts(rawEnv[key]!))
		return set.length > 0 ? [`  ${set.join(', ')}: ${reason}`] : []
	})
	if (contradictions.length === 0) return
	throw new Error(
		[
			'DEMO is set, but these variables contradict what it does:',
			...contradictions,
			'Unset them, or drop DEMO and configure the instance yourself.',
		].join('\n'),
	)
}

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

// One file per credential, named after the variable: the shape every secret mount produces (docker and podman
// secrets, a kubernetes secret volume, systemd's $CREDENTIALS_DIRECTORY). Only the variables the schema knows
// are read, so a directory shared with other services is fine. A single trailing newline is dropped, since most
// tools that write these files add one and no credential ends in one on purpose.
function readSecretsDir(): Record<string, string> {
	const dir = Cli.options?.secretsDir ?? process.env.SECRETS_DIR
	if (!dir) return {}
	let names: Set<string>
	try {
		names = new Set(fs.readdirSync(dir))
	} catch (error) {
		throw new Error(`Could not read the secrets directory at ${dir}`, { cause: error })
	}
	const secrets: Record<string, string> = {}
	for (const [key, schema] of entries()) {
		if (!isSecret(schema) || !names.has(key)) continue
		const filePath = path.join(dir, key)
		let contents: string
		try {
			contents = fs.readFileSync(filePath, 'utf8')
		} catch (error) {
			throw new Error(`Could not read the secret at ${filePath}`, { cause: error })
		}
		secrets[key] = contents.replace(/\r?\n$/, '')
	}
	return secrets
}

function readSecrets(): Record<string, string> {
	return { ...readSecretsFile(), ...readSecretsDir() }
}

export function ensureEnvSetup() {
	if (setup) return
	// entrypoints which don't use the cli system (scripts) still get the default .env; --env-file only overrides the path
	dotenv.config({ path: Cli.options?.envFile })
	const secrets = readSecrets()
	rawEnv = {}
	secretsFromEnvironment = []
	for (const [key, schema] of entries()) {
		const fromFile = isSecret(schema) ? secrets[key] : undefined
		const value = fromFile ?? process.env[key]
		if (value) rawEnv[key] = value
		if (value && isSecret(schema) && fromFile === undefined) secretsFromEnvironment.push(key)
	}

	const demo = groups.demo.DEMO.parse(rawEnv.DEMO)
	if (demo) {
		assertDemoIsUncontradicted()
		for (const [key, value] of Object.entries(DEMO_DEFAULTS)) {
			rawEnv[key] ??= value
		}
	}

	const toValidate = buildForValidation()
	// what DEMO deliberately does, so it only guards a real deployment
	if (!demo && toValidate.NODE_ENV === 'production' && toValidate.QUERY_PARAM_AUTH_BYPASS) {
		throw new Error('QUERY_PARAM_AUTH_BYPASS=true is not allowed in production')
	}

	setup = true
}

// Only the server's boot calls this (via SecretBox.setup), so that builds and scripts run with NODE_ENV=production
// against a dev .env still work. Only the current key is judged: the previous one is on its way out, and
// refusing it would block the rotation that gets rid of it.
export function assertEncryptionKeyIsStrong() {
	if (groups.demo.DEMO.parse(rawEnv.DEMO)) return
	if (buildForValidation().NODE_ENV !== 'production') return
	const key = rawEnv.SETTINGS_ENCRYPTION_KEY
	if (key === INSECURE_DEV_ENCRYPTION_KEY) {
		throw new Error(
			'SETTINGS_ENCRYPTION_KEY is the development key .env.example.dev ships, which is public. Generate a real one with `openssl rand -base64 32`.',
		)
	}
	if (key !== undefined && key.length < MIN_ENCRYPTION_KEY_LENGTH) {
		throw new Error(
			`SETTINGS_ENCRYPTION_KEY is ${key.length} characters, and production needs at least ${MIN_ENCRYPTION_KEY_LENGTH}. ` +
				'To rotate it without re-entering secrets, move the current value to SETTINGS_ENCRYPTION_KEY_PREVIOUS and generate a new one with `openssl rand -base64 32`.',
		)
	}
}
