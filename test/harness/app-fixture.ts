import * as Schema from '$root/drizzle/schema.ts'
import { superjsonify } from '@/lib/drizzle'
import { tsMigrations } from '@/migrations/registry'
import * as SETTINGS from '@/models/settings.models'
import * as Migrate from '@/server/migrate'
import Database, { type Database as SqliteDb } from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { Emulator, type EmulatorOptions } from '../../src/emulator'

// Boots the real app (child process, real boot path) against an emulated squad server, with an
// ephemeral sqlite db and ports, for integration tests. One fixture = one app instance + one
// emulated server; parallel suites are isolated by construction.

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

// layer db + layer-db.json are generated artifacts and not present in fresh worktrees; fall back
// to the main checkout's copies when running from one. `exists` is checked on a concrete probe
// path since LAYERS_DB_PATH contains a version template.
function resolveGeneratedPath(relPath: string, probeGlobDir?: string): string {
	const worktreeMarker = `${path.sep}.claude${path.sep}worktrees${path.sep}`
	const roots = [REPO_ROOT]
	if (REPO_ROOT.includes(worktreeMarker)) roots.push(REPO_ROOT.split(worktreeMarker)[0])
	for (const root of roots) {
		if (probeGlobDir) {
			const dir = path.join(root, probeGlobDir)
			if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /^layers_v.*\.sqlite3(\.gz)?$/.test(f))) {
				return path.join(root, relPath)
			}
		} else if (fs.existsSync(path.join(root, relPath))) {
			return path.join(root, relPath)
		}
	}
	return path.join(REPO_ROOT, relPath)
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer()
		srv.once('error', reject)
		srv.listen(0, '127.0.0.1', () => {
			const port = (srv.address() as net.AddressInfo).port
			srv.close(() => resolve(port))
		})
	})
}

export type AppFixtureOptions = {
	serverId?: string
	emulator?: EmulatorOptions
	env?: Record<string, string>
	// skip spawning; useful to test seeding in isolation
	spawn?: boolean
}

export type AppFixture = {
	emu: Emulator
	serverId: string
	appPort: number
	appUrl: string
	dbPath: string
	tmpDir: string
	logFile: string
	child: childProcess.ChildProcess | null
	// fresh read-only connection to the app's db, for assertions
	readDb: () => SqliteDb
	waitFor: <T>(probe: () => T | Promise<T>, opts?: { timeoutMs?: number; intervalMs?: number; label?: string }) => Promise<NonNullable<T>>
	dispose: () => Promise<void>
}

const LOG_AGENT_TOKEN = 'integ-test-token'

export async function createAppFixture(opts: AppFixtureOptions = {}): Promise<AppFixture> {
	const serverId = opts.serverId ?? 'emu-server-1'
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-integ-'))
	const dbPath = path.join(tmpDir, 'main.sqlite3')
	const logFile = path.join(tmpDir, 'app.log')

	const emu = new Emulator(opts.emulator)
	await emu.start()

	// migrate + seed before the app boots, so the server registry sees the emulated server
	const driver = new Database(dbPath)
	await Migrate.runMigrations(driver, { sqlDir: path.join(REPO_ROOT, 'drizzle-sqlite'), tsMigrations })
	const db = drizzle(driver)
	const serverSettings = SETTINGS.ServerSettingsSchema.parse({
		connections: {
			rcon: { host: '127.0.0.1', port: emu.rconPort, password: emu.password },
			logs: { type: 'log-receiver', token: LOG_AGENT_TOKEN },
		},
		adminListSources: [],
		adminIdentifyingPermissions: [],
	})
	await db.insert(Schema.servers).values(
		superjsonify(Schema.servers, {
			id: serverId,
			displayName: 'Emulated Server',
			enabled: true,
			defaultServer: true,
			settings: serverSettings,
		}),
	)
	driver.close()

	// the layer db is a hard runtime prerequisite: the app cannot boot without it, and it's a
	// generated artifact (pnpm preprocess) that fresh checkouts don't have. Fail fast and clearly.
	const layersDbPath = process.env.LAYERS_DB_PATH ?? resolveGeneratedPath('data/layers_v{{LAYERS_VERSION}}.sqlite3.gz', 'data')
	const layerDbConfigPath = process.env.LAYER_DB_CONFIG_PATH ?? resolveGeneratedPath('layer-db.json')
	const layersDbDir = path.dirname(layersDbPath)
	if (!fs.existsSync(layersDbDir) || !fs.readdirSync(layersDbDir).some((f) => /^layers_v.*\.sqlite3(\.gz)?$/.test(f))) {
		throw new Error(
			`integration tests need the layer db artifact (layers_v*.sqlite3[.gz]) but none was found in ${layersDbDir}. `
				+ `Generate it with \`pnpm preprocess\` or point LAYERS_DB_PATH at an existing copy.`,
		)
	}
	if (!fs.existsSync(layerDbConfigPath)) {
		throw new Error(`integration tests need layer-db.json but it was not found at ${layerDbConfigPath}. Set LAYER_DB_CONFIG_PATH.`)
	}

	const [appPort, logsReceiverPort] = await Promise.all([freePort(), freePort()])
	const appUrl = `http://127.0.0.1:${appPort}`

	const env: Record<string, string> = {
		...process.env as Record<string, string>,
		NODE_ENV: 'test',
		OTEL_ENABLED: 'false',
		DB_PATH: dbPath,
		DB_AUTOMIGRATE: 'false',
		PORT: String(appPort),
		HOST: '127.0.0.1',
		ORIGIN: appUrl,
		SQUAD_LOGS_RECEIVER_PORT: String(logsReceiverPort),
		DISCORD_ENABLED: 'false',
		DISCORD_CLIENT_ID: 'disabled',
		DISCORD_CLIENT_SECRET: 'disabled',
		DISCORD_BOT_TOKEN: 'disabled',
		DISCORD_HOME_GUILD_ID: '1',
		BM_PAT: 'disabled',
		BM_ORG_ID: '0',
		QUERY_PARAM_AUTH_BYPASS: 'true',
		LAYERS_DB_PATH: layersDbPath,
		LAYER_DB_CONFIG_PATH: layerDbConfigPath,
		...opts.env,
	}

	let child: childProcess.ChildProcess | null = null
	let childExited: Promise<number | null> | null = null

	async function waitFor<T>(
		probe: () => T | Promise<T>,
		waitOpts?: { timeoutMs?: number; intervalMs?: number; label?: string },
	): Promise<NonNullable<T>> {
		const timeoutMs = waitOpts?.timeoutMs ?? 30_000
		const intervalMs = waitOpts?.intervalMs ?? 200
		const deadline = Date.now() + timeoutMs
		let lastErr: Error | undefined
		while (Date.now() < deadline) {
			try {
				const res = await probe()
				if (res !== null && res !== undefined && res !== false) return res as NonNullable<T>
			} catch (err) {
				lastErr = err instanceof Error ? err : new Error(String(err))
			}
			await new Promise((r) => setTimeout(r, intervalMs))
		}
		const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').slice(-30).join('\n') : '(no log file)'
		throw new Error(
			`timed out waiting for ${waitOpts?.label ?? 'probe'} after ${timeoutMs}ms.`
				+ (lastErr ? ` last error: ${lastErr.message}` : '')
				+ `\napp log tail:\n${tail}`,
		)
	}

	if (opts.spawn !== false) {
		const out = fs.openSync(logFile, 'a')
		child = childProcess.spawn(
			path.join(REPO_ROOT, 'node_modules/.bin/tsx'),
			['--tsconfig', 'tsconfig.node.json', 'src/server/main.ts'],
			{ cwd: REPO_ROOT, env, stdio: ['ignore', out, out] },
		)
		childExited = new Promise((resolve) => child!.once('exit', (code) => resolve(code)))

		await waitFor(async () => {
			if (child!.exitCode !== null) {
				const tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n')
				throw new Error(`app exited with code ${child!.exitCode} during boot.\napp log tail:\n${tail}`)
			}
			const res = await fetch(`${appUrl}/check-auth`).catch(() => null)
			return res !== null
		}, { label: 'app readiness', timeoutMs: 60_000 })

		await emu.attachLogAgent({ host: '127.0.0.1', port: logsReceiverPort, serverId, token: LOG_AGENT_TOKEN })
	}

	return {
		emu,
		serverId,
		appPort,
		appUrl,
		dbPath,
		tmpDir,
		logFile,
		child,
		readDb: () => new Database(dbPath, { readonly: true }),
		waitFor,
		dispose: async () => {
			if (child && child.exitCode === null) {
				child.kill('SIGTERM')
				const killTimer = setTimeout(() => child?.kill('SIGKILL'), 8000)
				await childExited
				clearTimeout(killTimer)
			}
			emu.dispose()
			// set SLM_KEEP_TEST_TMP=1 to retain the db + app log of a failing run
			if (!process.env.SLM_KEEP_TEST_TMP) fs.rmSync(tmpDir, { recursive: true, force: true })
		},
	}
}
