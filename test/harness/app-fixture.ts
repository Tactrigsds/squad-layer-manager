import * as Schema from '$root/drizzle/schema.ts'
import { superjsonify } from '@/lib/drizzle'
import { tsMigrations } from '@/migrations/registry'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LL from '@/models/layer-list.models'
import * as SETTINGS from '@/models/settings.models'
import type * as SM from '@/models/squad.models'
import * as Migrate from '@/server/migrate'
import Database, { type Database as SqliteDb } from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { Emulator, type EmulatorOptions } from '../../src/emulator'
import { BmServer } from '../../src/emulator/bm-server'

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

// the layer components are static app data, loaded at runtime rather than bundled. Anything that
// resolves a layer id (getLayerCommand here) needs them, and playwright -- unlike vitest -- has no
// setup file to do it, so the fixture loads them itself.
let layerDataLoaded = false
function ensureLayerData() {
	if (layerDataLoaded) return
	const file = JSON.parse(fs.readFileSync(resolveGeneratedPath('data/layer-data.json'), 'utf8')) as L.LayerDataFile
	L.setLayerData({ components: LC.buildFullLayerComponents(file.components), factionUnits: file.factionUnits })
	layerDataLoaded = true
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

// steamIds link this user to in-game players (linkedSteamAccounts), which is how a chat command's
// sender is resolved back to an SLM user for permission checks
export type TestUser = {
	discordId: bigint
	username: string
	steamIds?: string[]
	// grants every permission via the SUPER_USERS bootstrap. Off by default for seeded users, so a test
	// can have someone the permission checks actually say no to.
	superUser?: boolean
}

export type AppFixtureOptions = {
	serverId?: string
	emulator?: EmulatorOptions
	env?: Record<string, string>
	// extra users to seed beyond the default admin; only the admin gets superuser perms
	users?: TestUser[]
	// steam ids linked to the seeded admin, so an in-game player sending a chat command resolves to
	// a user the permission checks recognise
	adminSteamIds?: string[]
	// mutate the settings before they're written, in place. Called with fully-parsed defaults (with
	// the test timings below already applied), so durations are milliseconds, not '3m' strings.
	globalSettings?: (settings: SETTINGS.GlobalSettings) => void
	serverSettings?: (settings: SETTINGS.ServerSettings) => void
	// the queue the server starts with. Seeding one (and pinning queue.preferredLength to its length,
	// which arrange() does) stops the generator from filling the queue with random layers, which is
	// what makes a queue assertion worth writing.
	layerQueue?: LL.List
	// steam ids that are admins in game. Written to an Admins.cfg the app reads as a `local` admin
	// list source, so these players come back from ListPlayers with isAdmin set.
	admins?: string[]
	// skip spawning; useful to test seeding in isolation
	spawn?: boolean
}

export type AppFixture = {
	emu: Emulator
	// stub BattleMetrics API the app talks to; inspect bm.requestLog / bm.players to assert writes
	bm: BmServer
	serverId: string
	appPort: number
	appUrl: string
	dbPath: string
	tmpDir: string
	logFile: string
	// the emulated squad server's SquadGame.log, which the app tails
	squadLogPath: string
	// the Admins.cfg the app reads as a local admin list source; rewrite it to change who is an admin
	adminsCfgPath: string
	child: childProcess.ChildProcess | null
	adminUser: TestUser
	// url that logs the given user in via the query-param auth bypass, for the e2e client to open
	loginUrl: (user?: TestUser, path?: string) => string
	// resolves once the app's roster cache reflects the emulator's current players. The app reads the
	// roster from a polled ListPlayers, so a player who just joined isn't known to it yet -- anything
	// that resolves a player (chat commands, warns) needs this first.
	waitForRosterSync: (opts?: { timeoutMs?: number }) => Promise<void>
	// fresh read-only connection to the app's db, for assertions
	readDb: () => SqliteDb
	waitFor: <T>(probe: () => T | Promise<T>, opts?: { timeoutMs?: number; intervalMs?: number; label?: string }) => Promise<NonNullable<T>>
	dispose: () => Promise<void>
}

// snowflake-shaped ids so nothing downstream trips on the bigint range
export const ADMIN_USER: TestUser = { discordId: 900000000000000001n, username: 'test-admin' }

// the in-game admin group the seeded Admins.cfg grants, and the permission the app looks for when
// deciding which connected players are admins
const ADMIN_GROUP = 'SlmTestAdmin'
const ADMIN_PERM: SM.PlayerPerm = 'canseeadminchat'
const ADMIN_LIST_SOURCE = 'test-admins'

function renderAdminsCfg(steamIds: string[]): string {
	const lines = [`Group=${ADMIN_GROUP}:${ADMIN_PERM},balance,cameraman,teamchange`]
	for (const steamId of steamIds) lines.push(`Admin=${steamId}:${ADMIN_GROUP}`)
	return lines.join('\n') + '\n'
}

// Durations that would make a test sit and wait. Every one is a setting, and settings are the only
// lever we have: the app runs in its own process, so its timers can't be faked. Tests override any
// of these through the globalSettings hook.
function applyTestTimings(settings: SETTINGS.GlobalSettings) {
	settings.vote.voteDuration = 8_000
	settings.vote.finalVoteReminder = 2_000
	settings.vote.voteReminderInterval = 3_000
	settings.vote.internalVoteReminderInterval = 3_000
	settings.layerQueue.adminQueueReminderInterval = 5_000
	settings.postRollAnnouncementsTimeout = 2_000
	settings.fogOffDelay = 2_000
	// the log tail's poll interval is also the window the event pipeline waits for the log to catch
	// up with rcon/poll events, so a short one keeps tests responsive
	settings.squadServer.logFilePollInterval = 250
}

export async function createAppFixture(opts: AppFixtureOptions = {}): Promise<AppFixture> {
	const serverId = opts.serverId ?? 'emu-server-1'
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-integ-'))
	const dbPath = path.join(tmpDir, 'main.sqlite3')
	const logFile = path.join(tmpDir, 'app.log')

	const emu = new Emulator(opts.emulator)
	await emu.start()
	const bm = new BmServer()
	const bmPort = await bm.listen()

	// migrate + seed before the app boots, so the server registry sees the emulated server
	const driver = new Database(dbPath)
	await Migrate.runMigrations(driver, { sqlDir: path.join(REPO_ROOT, 'drizzle-sqlite'), tsMigrations })
	const db = drizzle(driver)
	// -------- in-game admins --------
	const adminsCfgPath = path.join(tmpDir, 'Admins.cfg')
	fs.writeFileSync(adminsCfgPath, renderAdminsCfg(opts.admins ?? []))

	// -------- global settings --------
	// written before boot rather than defaulted by the app, so tests can arrange the durations and
	// command config they depend on (settings.server only inserts defaults when the row is absent)
	const globalSettings = SETTINGS.GlobalSettingsSchema.parse({})
	applyTestTimings(globalSettings)
	globalSettings.adminListSources[ADMIN_LIST_SOURCE] = { type: 'local', source: adminsCfgPath }
	opts.globalSettings?.(globalSettings)
	await db.insert(Schema.globalSettings).values(
		superjsonify(Schema.globalSettings, { id: 1, settings: SETTINGS.GlobalSettingsSchema.encode(globalSettings) }),
	)

	// -------- server --------
	// the emulator writes its log to a file and the app tails it, the same `local-file` path a
	// same-host squad server uses. No test-only transport in between.
	const squadLogPath = path.join(tmpDir, 'SquadGame.log')
	const serverSettings = SETTINGS.ServerSettingsSchema.parse({
		connections: {
			rcon: { host: '127.0.0.1', port: emu.rconPort, password: emu.password },
			logs: { type: 'local-file', logFile: squadLogPath },
		},
		adminListSources: [ADMIN_LIST_SOURCE],
		adminIdentifyingPermissions: [ADMIN_PERM],
	})
	// a seeded queue is only stable if nothing tops it up: generation fills the queue to
	// preferredLength with random layers, so pin that to what we seeded
	const layerQueue = opts.layerQueue ?? []
	if (opts.layerQueue) serverSettings.queue.preferredLength = opts.layerQueue.length
	opts.serverSettings?.(serverSettings)

	// Put the emulated server's next layer where a steady-state server's would be: on the head of
	// SLM's queue. A server whose next layer disagrees with the queue is the *external set* path -- the
	// app pulls that layer into the head of its queue -- which would quietly displace what we seeded.
	// (A test that wants that path sets emulator.nextLayer itself.)
	if (opts.layerQueue && !opts.emulator?.nextLayer) {
		const headLayerId = LL.getNextLayerId(layerQueue)
		if (headLayerId) {
			ensureLayerData()
			emu.world.handleCommand(L.getLayerCommand(headLayerId, 'set-next'))
		}
	}

	await db.insert(Schema.servers).values(
		superjsonify(Schema.servers, {
			id: serverId,
			displayName: 'Emulated Server',
			enabled: true,
			defaultServer: true,
			layerQueue,
			settings: serverSettings,
		}),
	)

	// -------- users --------
	// the bypass login resolves users by username against this table; the admin additionally gets
	// every permission via the SUPER_USERS env bootstrap below
	const users = [{ ...ADMIN_USER, steamIds: opts.adminSteamIds }, ...(opts.users ?? [])]
	await db.insert(Schema.users).values(users.map((u) => ({ discordId: u.discordId, username: u.username })))
	const steamLinks = users.flatMap((u) => (u.steamIds ?? []).map((steamId) => ({ steam64Id: BigInt(steamId), discordId: u.discordId })))
	if (steamLinks.length > 0) await db.insert(Schema.linkedSteamAccounts).values(steamLinks)
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

	emu.attachLogFile(squadLogPath)

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
		BM_HOST: `http://127.0.0.1:${bmPort}`,
		BM_PAT: 'stub-token',
		BM_ORG_ID: 'stub-org',
		QUERY_PARAM_AUTH_BYPASS: 'true',
		SUPER_USERS: users.filter((u) => u.superUser ?? u.discordId === ADMIN_USER.discordId).map((u) => String(u.discordId)).join(','),
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
	}

	return {
		emu,
		bm,
		serverId,
		appPort,
		appUrl,
		dbPath,
		tmpDir,
		logFile,
		squadLogPath,
		adminsCfgPath,
		child,
		adminUser: ADMIN_USER,
		loginUrl: (user = ADMIN_USER, urlPath = '/') => `${appUrl}${urlPath}?login=${encodeURIComponent(user.username)}`,
		waitForRosterSync: async (syncOpts) => {
			// two polls, not one: the roster resource fetches under a mutex, so the second ListPlayers
			// can only have been issued after the first one's response was parsed and cached
			const from = emu.rcon.commandLog.length
			await waitFor(
				() => emu.rcon.commandLog.slice(from).filter((c) => c.body === 'ListPlayers').length >= 2,
				{ label: 'roster poll', timeoutMs: syncOpts?.timeoutMs ?? 25_000 },
			)
		},
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
			bm.close()
			// set SLM_KEEP_TEST_TMP=1 to retain the db + app log of a failing run
			if (!process.env.SLM_KEEP_TEST_TMP) fs.rmSync(tmpDir, { recursive: true, force: true })
		},
	}
}
