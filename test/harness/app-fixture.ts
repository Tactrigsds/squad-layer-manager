import Database, { type Database as SqliteDb } from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import * as Schema from '$root/drizzle/schema.ts'
import * as DevInstance from '@/dev/instance'
import { superjsonify } from '@/lib/drizzle'
import { tsMigrations } from '@/migrations/registry'
import type * as BB from '@/models/backburner.models'
import type * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as SETTINGS from '@/models/settings.models'
import type * as SM from '@/models/squad.models'
import * as Migrate from '@/server/migrate'
import * as LayerArtifacts from '@/systems/layer-artifacts.server'

import { Emulator, type EmulatorOptions } from '../../src/emulator'
import { BmServer } from '../../src/emulator/bm-server'

// Boots the real app (child process, real boot path) against an emulated squad server, with an
// ephemeral sqlite db and ports, for integration tests. One fixture = one app instance + one
// emulated server; parallel suites are isolated by construction.

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

// How to start the app under test. SLM_TEST_SERVER_ENTRY points at a bundled server: the docker image sets it
// to the artifact it ships, so CI drives the very thing that gets deployed, and locally the test scripts build
// one first, because transpiling the module graph through tsx costs ~3.5s of every boot and there are dozens
// of those in a run (see scripts/test-server-bundle.mjs). Without it, the tsx path below runs the sources
// directly, which is what `test:integration:src` / `test:e2e:src` are for.
function serverCommand(): [string, string[]] {
	// main-instrumented is the entry production runs: it starts the otel sdk (when OTEL_ENABLED) and then
	// hands off to main. Spawning it -- rather than main directly -- is what lets a test's telemetry exist
	// at all. register-otel.mjs installs the loader hook the auto-instrumentations need.
	const otelLoader = ['--import', path.join(REPO_ROOT, 'register-otel.mjs')]
	const entry = process.env.SLM_TEST_SERVER_ENTRY
	// the same two preloads, in the same order, that `pnpm run server:prod` passes
	if (entry) return ['node', ['--import', path.join(REPO_ROOT, 'register-source-maps.mjs'), ...otelLoader, entry]]
	return [
		path.join(REPO_ROOT, 'node_modules/.bin/tsx'),
		['--tsconfig', 'tsconfig.node.json', ...otelLoader, 'src/server/main-instrumented.ts'],
	]
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
// One id for the whole test run (all fixtures in it), so a Grafana query can scope to "this run" and
// then narrow to one test. Overridable so CI can use its run id.
const TEST_RUN_ID = process.env.SLM_TEST_RUN_ID ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const OTEL_SERVICE_NAME = process.env.SLM_TEST_OTEL_SERVICE_NAME ?? 'slm-test'

// The name of the test currently running, if the runner told us. Playwright's fixture sets this (see
// test/e2e/fixtures.ts) so that an app built inside a test is labelled with that test, without every
// test file having to say so.
let currentLabel: string | undefined
export function setCurrentTestLabel(label: string | undefined) {
	currentLabel = label
}

// the test file that built this fixture, read off the stack: runner-agnostic, and enough to find the
// telemetry again even when a test didn't name itself
function callerFile(): string {
	const stack = new Error().stack?.split('\n') ?? []
	for (const line of stack) {
		const match = line.match(/\(?(\/[^\s):]+\.test\.ts)/)
		if (match) return path.basename(match[1])
	}
	return 'unknown'
}

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
	// what to call this app's telemetry. Normally the test's own name -- the e2e fixture passes it
	// automatically; a vitest test can pass its own. Falls back to the file that created the fixture.
	label?: string
	// export telemetry for this app regardless of SLM_TEST_OTEL, optionally somewhere other than the
	// configured collector
	otel?: { endpoint?: string }
	// extra users to seed beyond the default admin; only the admin gets superuser perms
	users?: TestUser[]
	// steam ids linked to the seeded admin, so an in-game player sending a chat command resolves to
	// a user the permission checks recognise
	adminSteamIds?: string[]
	// mutate the settings before they're written, in place. Called with fully-parsed defaults (with
	// the test timings below already applied), so durations are milliseconds, not '3m' strings.
	globalSettings?: (settings: SETTINGS.GlobalSettings) => void
	serverSettings?: (settings: SETTINGS.ServerSettings) => void
	// the queue the server starts with. Generation only fires when the saved list would be empty, so a
	// seeded queue stays exactly as seeded, which is what makes a queue assertion worth writing.
	layerQueue?: LL.List
	// filter entities to seed. A server's pool config (serverSettings.queue.mainPool) references
	// these by id, so anything that applies, indicates or warns on a filter needs them seeded first.
	filters?: F.FilterEntity[]
	// saved layer requests (backburner) to seed
	backburner?: BB.BackburnerItem[]
	// steam ids that are admins in game. Written to an Admins.cfg the app reads as a `local` admin
	// list source, so these players come back from ListPlayers with isAdmin set.
	admins?: string[]
	// steam ids written into a second admin-list group that holds no admin-identifying permission (a
	// reserve-slot / Whitelist group). They appear in the admin list -- getPlayerGroups sees them -- but
	// getIsAdmin must not, so they exercise the identifying-permission gate.
	reserveAdmins?: string[]
	// skip spawning; useful to test seeding in isolation
	spawn?: boolean
	// how the app reaches the emulated server. 'local' (default) tails the SquadGame.log directly and dials
	// RCON directly; 'server-agent' runs the real rust server agent (server-agent/agent), which tails that
	// same file and proxies RCON, streaming both to the app over the /server-agent websocket. Exercises the
	// full remote-agent pipeline including the RCON tunnel.
	logSource?: 'local' | 'server-agent'
	// a second enabled server, with an emulator and log file of its own, for anything about choosing between
	// servers. Off by default: it costs a second emulator and a second slice, and every other test would rather
	// have one server whose state it fully controls.
	secondServer?: boolean | { id?: string; displayName?: string }
}

export type AppFixture = {
	emu: Emulator
	// the running server agent when logSource is 'server-agent' (else null); stop()/start() drive reconnect tests
	serverAgent: ServerAgentController | null
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
	// the second server, when `secondServer` asked for one: its id and its own emulator
	second: { serverId: string; displayName: string; emu: Emulator } | null
	// the Admins.cfg the app reads as a local admin list source; rewrite it to change who is an admin
	adminsCfgPath: string
	child: childProcess.ChildProcess | null
	adminUser: TestUser
	// the resource attributes this app's telemetry carries (see SLM_TEST_OTEL)
	otelLabels: Record<string, string>
	// url that logs the given user in via the query-param auth bypass, for the e2e client to open
	loginUrl: (user?: TestUser, path?: string) => string
	// resolves once the app's roster cache reflects the emulator's current players. The app reads the
	// roster from a polled ListPlayers, so a player who just joined isn't known to it yet -- anything
	// that resolves a player (chat commands, warns) needs this first.
	waitForRosterSync: (opts?: { timeoutMs?: number }) => Promise<void>
	// fresh read-only connection to the app's db, for assertions
	readDb: () => SqliteDb
	waitFor: <T>(probe: () => T | Promise<T>, opts?: { timeoutMs?: number; intervalMs?: number; label?: string }) => Promise<NonNullable<T>>
	// stop the app and boot it again against the same db, emulator and ports. For anything that only happens on
	// boot -- notably the feed backfill, which rebuilds state from the db rather than from what it saw live.
	// `child` on the fixture is the original process and goes stale across this; nothing else does.
	// `whileDown` runs against the still-live emulator between the two, for what the app has to work out on boot
	// rather than observe: a map roll it was not running for.
	restart: (whileDown?: () => Promise<void> | void) => Promise<void>
	dispose: () => Promise<void>
}

// snowflake-shaped ids so nothing downstream trips on the bigint range
export const ADMIN_USER: TestUser = { discordId: 900000000000000001n, username: 'test-admin' }

// the in-game admin group the seeded Admins.cfg grants, and the permission the app looks for when
// deciding which connected players are admins
const ADMIN_GROUP = 'SlmTestAdmin'
const ADMIN_PERM: SM.PlayerPerm = 'canseeadminchat'
// the single admin list the harness defines; tests name it when assigning roles to in-game admins
export const TEST_ADMIN_LIST = 'test-admins'
// a group holding no admin-identifying permission, for reserveAdmins
const RESERVE_GROUP = 'SlmTestReserve'
const RESERVE_PERM: SM.PlayerPerm = 'reserve'
const SERVER_AGENT_TOKEN = 'test-server-agent-token'
const AGENT_DIR = path.join(REPO_ROOT, 'server-agent/agent')

// Resolves the real server agent binary, building it once (release) if no build is present. The debug build
// is preferred when it already exists so a dev iterating on tests doesn't pay for a release compile.
function resolveAgentBinary(): string {
	const exe = process.platform === 'win32' ? 'slm-server-agent.exe' : 'slm-server-agent'
	for (const profile of ['release', 'debug']) {
		const candidate = path.join(AGENT_DIR, 'target', profile, exe)
		if (fs.existsSync(candidate)) return candidate
	}
	childProcess.execFileSync('cargo', ['build', '--release'], { cwd: AGENT_DIR, stdio: 'inherit' })
	return path.join(AGENT_DIR, 'target', 'release', exe)
}

// Runs the real rust server agent against the emulator's SquadGame.log and RCON port, streaming both to the
// app's /server-agent websocket. Returns a controller so tests can drop and restart it (reconnect scenarios).
type ServerAgentController = {
	start: () => void
	stop: () => void
	dispose: () => void
}

function startServerAgent(args: {
	appPort: number
	serverId: string
	logPath: string
	agentLogPath: string
	rconPort: number
	rconPassword: string
}): ServerAgentController {
	const binary = resolveAgentBinary()
	let child: childProcess.ChildProcess | null = null
	const start = () => {
		if (child) return
		const out = fs.openSync(args.agentLogPath, 'a')
		child = childProcess.spawn(
			binary,
			[
				'--url',
				`ws://127.0.0.1:${args.appPort}/server-agent`,
				'--server-id',
				args.serverId,
				'--token',
				SERVER_AGENT_TOKEN,
				'--file',
				args.logPath,
				// the agent holds the RCON creds and proxies them; the app never sees them for a server-agent server
				'--rcon-host',
				'127.0.0.1',
				'--rcon-port',
				String(args.rconPort),
				'--rcon-password',
				args.rconPassword,
				// tests move fast; poll and reconnect quickly so assertions don't wait on the agent
				'--poll-ms',
				'100',
				'--reconnect-ms',
				'300',
			],
			{ stdio: ['ignore', out, out] },
		)
		child.once('exit', () => {
			child = null
		})
	}
	const stop = () => {
		if (!child) return
		child.kill('SIGKILL')
		child = null
	}
	start()
	return { start, stop, dispose: stop }
}

function renderAdminsCfg(steamIds: string[], reserveIds: string[] = []): string {
	let cfg = DevInstance.renderAdminsCfg(steamIds, ADMIN_GROUP, [ADMIN_PERM, 'balance', 'cameraman', 'teamchange'])
	if (reserveIds.length > 0) cfg += DevInstance.renderAdminsCfg(reserveIds, RESERVE_GROUP, [RESERVE_PERM])
	return cfg
}

const LOG_FILE_POLL_INTERVAL = 250

// How long after the emulator logs something before the app is certain to have read it: one poll of the log tail
// plus the parser's wait for the tick to go quiet (squad-server.server.ts derives both from the same interval),
// with the same again for slack. A test that needs the app to have *seen* something has to wait this out.
export const LOG_INGEST_SETTLE_MS = (LOG_FILE_POLL_INTERVAL + LOG_FILE_POLL_INTERVAL * 1.5) * 2

// Durations that would make a test sit and wait. Every one is a setting, and settings are the only
// lever we have: the app runs in its own process, so its timers can't be faked. Tests override any
// of these through the globalSettings / serverSettings hooks.
function applyTestTimings(settings: SETTINGS.GlobalSettings) {
	// the log tail's poll interval is also the window the event pipeline waits for the log to catch
	// up with rcon/poll events, so a short one keeps tests responsive
	settings.logFilePollInterval = LOG_FILE_POLL_INTERVAL
}

// The roster TTL doubles as the ListPlayers poll interval, so it sets the floor on waitForRosterSync
// (which wants two polls) and dominates this suite's wall time.
//
// What these can be is a function of how loaded the box is, because the failure mode is core-rcon's 2s
// response timeout: poll faster than a busy machine can drain RCON and commands queue until responses
// breach it. At 2s each the suite ran 58s; 1s each ran 41s over three clean runs, which only became safe
// once each app stopped booting through tsx and stopped seeding a sandbox server alongside the one under
// test. 500ms measured clean here too (36s), and is deliberately not taken: CI runs this in a container
// on fewer cores than the machine it was measured on, and a flaky integration suite is not worth 5s.
function applyTestServerTimings(settings: SETTINGS.ServerSettings) {
	settings.rconCacheTTL.layersStatus = 1_000
	settings.rconCacheTTL.serverInfo = 2_000
	settings.rconCacheTTL.teams = 1_000
	settings.vote.voteDuration = 8_000
	settings.vote.finalVoteReminder = 2_000
	settings.vote.voteReminderInterval = 3_000
	settings.vote.internalVoteReminderInterval = 3_000
	settings.queue.adminQueueReminderInterval = 5_000
	settings.postRollAnnouncementsTimeout = 2_000
	settings.fogOffDelay = 2_000
}

export async function createAppFixture(opts: AppFixtureOptions = {}): Promise<AppFixture> {
	// the emulator resolves its team names from the layer's factions, so this has to happen before it exists
	DevInstance.ensureLayerData()
	const serverId = opts.serverId ?? 'emu-server-1'
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slm-integ-'))
	const dbPath = path.join(tmpDir, 'main.sqlite3')
	const logFile = path.join(tmpDir, 'app.log')

	// A real server (and so the emulator's default) spends 30s in WaitingPostMatch before it brings the next world
	// up. Nothing in a suite should wait that long for a roll it asked for, so the harness turns it down; a test
	// that cares about the real duration can pass its own.
	const emulatorOpts: EmulatorOptions = { postMatchDelayMs: 50, ...opts.emulator }
	const emu = new Emulator(emulatorOpts)
	await emu.start()
	const secondOpts = opts.secondServer === true ? {} : opts.secondServer || null
	const secondId = secondOpts?.id ?? 'emu-server-2'
	const secondDisplayName = secondOpts?.displayName ?? 'Second Emulated Server'
	const secondEmu = secondOpts ? await new Emulator(emulatorOpts).start() : null
	const bm = new BmServer()
	const bmPort = await bm.listen()

	// migrate + seed before the app boots, so the server registry sees the emulated server
	const driver = new Database(dbPath)
	await Migrate.runMigrations(driver, { sqlDir: path.join(REPO_ROOT, 'drizzle-sqlite'), tsMigrations })
	const db = drizzle(driver)
	// -------- in-game admins --------
	const adminsCfgPath = path.join(tmpDir, 'Admins.cfg')
	fs.writeFileSync(adminsCfgPath, renderAdminsCfg(opts.admins ?? [], opts.reserveAdmins ?? []))

	// -------- global settings --------
	// written before boot rather than defaulted by the app, so tests can arrange the durations and
	// command config they depend on (settings.server only inserts defaults when the row is absent)
	// parseGlobalSettings, not the schema directly: command configs have no schema-level defaults (their strings
	// depend on defaultPrefix), so they're seeded before the parse
	const parsedSettings = SETTINGS.parseGlobalSettings({})
	if (!parsedSettings.success) throw new Error(`default global settings do not parse: ${parsedSettings.error}`)
	const globalSettings = parsedSettings.data
	applyTestTimings(globalSettings)
	// admin lists are named and per-server (see migration 0092); the harness defines one and every test server uses it,
	// set before the hook so a test can override
	globalSettings.adminLists = {
		[TEST_ADMIN_LIST]: { source: { type: 'local', source: adminsCfgPath }, adminIdentifyingPermissions: [ADMIN_PERM] },
	}
	// A fresh install seeds a sandbox, which is a whole second squad server: its own in-process emulator, its own RCON
	// connection and its own polling loops, all running for the life of every test app. Nothing here drives it, and the
	// RCON traffic it adds is what the poll intervals above have to leave room for. A test that wants one turns it back on.
	globalSettings.seedSandboxServer = false
	opts.globalSettings?.(globalSettings)
	await db
		.insert(Schema.globalSettings)
		.values(superjsonify(Schema.globalSettings, { id: 1, settings: SETTINGS.GlobalSettingsSchema.encode(globalSettings) }))

	// -------- server --------
	// the emulator writes its log to a file and the app tails it, the same `local` path a
	// same-host squad server uses. No test-only transport in between.
	const squadLogPath = path.join(tmpDir, 'SquadGame.log')
	const logSource = opts.logSource ?? 'local'
	const serverSettings = SETTINGS.ServerSettingsSchema.parse({
		// server-agent mode keeps no RCON creds in the app: the agent holds them and proxies RCON over its tunnel
		connections:
			logSource === 'server-agent'
				? { type: 'server-agent', token: SERVER_AGENT_TOKEN }
				: {
						type: 'local',
						logFile: squadLogPath,
						rcon: { host: '127.0.0.1', port: emu.rconPort, password: emu.password },
					},
	})
	const layerQueue = opts.layerQueue ?? []
	applyTestServerTimings(serverSettings)
	// the harness's list applies to the test server, or nothing in it would recognise an admin
	serverSettings.adminLists = [TEST_ADMIN_LIST]
	opts.serverSettings?.(serverSettings)

	// Put the emulated server's next layer where a steady-state server's would be: on the head of
	// SLM's queue. A server whose next layer disagrees with the queue is the *external set* path -- the
	// app pulls that layer into the head of its queue -- which would quietly displace what we seeded.
	// (A test that wants that path sets emulator.nextLayer itself.)
	if (opts.layerQueue && !opts.emulator?.nextLayer) {
		const headLayerId = LL.getNextLayerId(layerQueue)
		if (headLayerId) emu.world.handleCommand(L.getLayerCommand(headLayerId, 'set-next'))
	}

	await db.insert(Schema.servers).values(
		superjsonify(Schema.servers, {
			id: serverId,
			displayName: 'Emulated Server',
			enabled: true,
			defaultServer: true,
			layerQueue,
			backburner: opts.backburner ?? [],
			settings: serverSettings,
		}),
	)

	// A second server is a whole second slice: its own emulator, its own log file, its own rcon. Sharing one
	// emulator between two slices would have them both driving the same world, which is not what two servers
	// means and would have them fighting over the next layer.
	const secondLogPath = path.join(tmpDir, 'SquadGame2.log')
	if (secondEmu) {
		const secondSettings = SETTINGS.ServerSettingsSchema.parse({
			connections: {
				type: 'local',
				logFile: secondLogPath,
				rcon: { host: '127.0.0.1', port: secondEmu.rconPort, password: secondEmu.password },
			},
		})
		applyTestServerTimings(secondSettings)
		secondSettings.adminLists = [TEST_ADMIN_LIST]
		await db.insert(Schema.servers).values(
			superjsonify(Schema.servers, {
				id: secondId,
				displayName: secondDisplayName,
				enabled: true,
				defaultServer: false,
				layerQueue: [],
				backburner: [],
				settings: secondSettings,
			}),
		)
	}

	// -------- users --------
	// the bypass login resolves users by username against this table; the admin additionally gets
	// every permission via the SUPER_USERS env bootstrap below
	const users = [{ ...ADMIN_USER, steamIds: opts.adminSteamIds }, ...(opts.users ?? [])]
	await db.insert(Schema.users).values(users.map((u) => ({ discordId: u.discordId, username: u.username })))
	const steamLinks = users.flatMap((u) => (u.steamIds ?? []).map((steamId) => ({ steam64Id: BigInt(steamId), discordId: u.discordId })))
	if (steamLinks.length > 0) await db.insert(Schema.linkedSteamAccounts).values(steamLinks)

	// -------- filters --------
	// after the users, since a filter's owner is a foreign key onto one. Inserted raw, not superjsonified:
	// filter-entity.server reads these rows straight into F.FilterEntitySchema.parse, so the `filter` column
	// holds plain json (unlike servers.layerQueue and the settings columns).
	if (opts.filters && opts.filters.length > 0) {
		await db.insert(Schema.filters).values(opts.filters)
	}
	driver.close()

	// the layer artifacts are a hard runtime prerequisite: the app cannot boot without them. They're checked in
	// (assets/layers), so this only fires when a checkout is broken -- but it fires here rather than as an opaque
	// boot failure in the child process.
	LayerArtifacts.resolvePair()

	emu.attachLogFile(squadLogPath)
	secondEmu?.attachLogFile(secondLogPath)

	const appPort = await freePort()
	const appUrl = `http://127.0.0.1:${appPort}`

	// -------- telemetry --------
	// Off by default: a test run shouldn't need a collector, and exporting costs time. Turned on
	// (SLM_TEST_OTEL=1, with the otel stack from docker-compose.yaml up) every span, log and metric this
	// app emits is labelled with the test that produced it, so a failure can be read in Grafana rather
	// than reconstructed from a log tail.
	const otelLabels: Record<string, string> = {
		'service.name': OTEL_SERVICE_NAME,
		'deployment.environment.name': 'test',
		'slm.test.run_id': TEST_RUN_ID,
		'slm.test.name': opts.label ?? currentLabel ?? callerFile(),
		'slm.test.file': callerFile(),
		'slm.test.server_id': serverId,
	}
	const otelEnabled = !!opts.otel || process.env.SLM_TEST_OTEL === '1' || process.env.SLM_TEST_OTEL === 'true'
	const otelEnv: Record<string, string> = otelEnabled
		? {
				OTEL_ENABLED: 'true',
				OTLP_COLLECTOR_ENDPOINT: opts.otel?.endpoint ?? process.env.OTLP_COLLECTOR_ENDPOINT ?? 'http://localhost:4318',
				// a test is short and rare: sample everything, or the one trace you want won't be there
				OTEL_TRACE_SAMPLE_RATIO: '1',
				OTEL_RESOURCE_ATTRIBUTES: Object.entries(otelLabels)
					.map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
					.join(','),
			}
		: { OTEL_ENABLED: 'false' }
	if (otelEnabled) {
		console.log(
			`[slm-test] telemetry: service.name=${OTEL_SERVICE_NAME} slm.test.run_id=${TEST_RUN_ID} slm.test.name="${
				otelLabels['slm.test.name']
			}"`,
		)
	}

	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		NODE_ENV: 'test',
		...otelEnv,
		DB_PATH: dbPath,
		DB_AUTOMIGRATE: 'false',
		PORT: String(appPort),
		HOST: '127.0.0.1',
		ORIGIN: appUrl,
		DISCORD_ENABLED: 'false',
		DISCORD_CLIENT_ID: 'disabled',
		DISCORD_CLIENT_SECRET: 'disabled',
		DISCORD_BOT_TOKEN: 'disabled',
		DISCORD_HOME_GUILD_ID: '1',
		BM_HOST: `http://127.0.0.1:${bmPort}`,
		BM_PAT: 'stub-token',
		BM_ORG_ID: 'stub-org',
		QUERY_PARAM_AUTH_BYPASS: 'true',
		// fixed 32-byte base64 key so encrypted settings survive across restarts within a test run
		SETTINGS_ENCRYPTION_KEY: 'c2xtLXRlc3QtZW5jcnlwdGlvbi1rZXktMzJieXRlcyE=',
		SUPER_USERS: users
			.filter((u) => u.superUser ?? u.discordId === ADMIN_USER.discordId)
			.map((u) => String(u.discordId))
			.join(','),
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
		// when telemetry is on, say where to find it: the log tail is what's left when you can't
		const telemetryHint = otelEnabled
			? `\ntelemetry: slm.test.run_id="${TEST_RUN_ID}" slm.test.name="${otelLabels['slm.test.name']}"`
			: ''
		throw new Error(
			`timed out waiting for ${waitOpts?.label ?? 'probe'} after ${timeoutMs}ms.` +
				(lastErr ? ` last error: ${lastErr.message}` : '') +
				telemetryHint +
				`\napp log tail:\n${tail}`,
		)
	}

	async function stopApp() {
		if (!child || child.exitCode !== null) return
		child.kill('SIGTERM')
		const killTimer = setTimeout(() => child?.kill('SIGKILL'), 8000)
		await childExited
		clearTimeout(killTimer)
	}

	async function spawnApp() {
		const out = fs.openSync(logFile, 'a')
		const [command, args] = serverCommand()
		child = childProcess.spawn(command, args, { cwd: REPO_ROOT, env, stdio: ['ignore', out, out] })
		childExited = new Promise((resolve) => child!.once('exit', (code) => resolve(code)))

		await waitFor(
			async () => {
				if (child!.exitCode !== null) {
					const tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n')
					throw new Error(`app exited with code ${child!.exitCode} during boot.\napp log tail:\n${tail}`)
				}
				const res = await fetch(`${appUrl}/check-auth`).catch(() => null)
				return res !== null
			},
			{ label: 'app readiness', timeoutMs: 60_000 },
		)
	}

	if (opts.spawn !== false) await spawnApp()

	// the real server agent tails the file the emulator writes and proxies its RCON; start it only once the
	// app is listening so its first connection lands
	let serverAgent: ServerAgentController | null = null
	if (logSource === 'server-agent' && opts.spawn !== false) {
		serverAgent = startServerAgent({
			appPort,
			serverId,
			logPath: squadLogPath,
			agentLogPath: path.join(tmpDir, 'server-agent.log'),
			rconPort: emu.rconPort,
			rconPassword: emu.password,
		})
	}

	return {
		emu,
		serverAgent,
		bm,
		serverId,
		appPort,
		appUrl,
		dbPath,
		tmpDir,
		logFile,
		squadLogPath,
		second: secondEmu ? { serverId: secondId, displayName: secondDisplayName, emu: secondEmu } : null,
		adminsCfgPath,
		child,
		adminUser: ADMIN_USER,
		otelLabels,
		loginUrl: (user = ADMIN_USER, urlPath = '/') => `${appUrl}${urlPath}?login=${encodeURIComponent(user.username)}`,
		waitForRosterSync: async (syncOpts) => {
			// two polls, not one: the roster resource fetches under a mutex, so the second ListPlayers
			// can only have been issued after the first one's response was parsed and cached
			const from = emu.rcon.commandLog.length
			await waitFor(() => emu.rcon.commandLog.slice(from).filter((c) => c.body === 'ListPlayers').length >= 2, {
				label: 'roster poll',
				timeoutMs: syncOpts?.timeoutMs ?? 25_000,
			})
		},
		readDb: () => new Database(dbPath, { readonly: true }),
		waitFor,
		restart: async (whileDown?: () => Promise<void> | void) => {
			await stopApp()
			await whileDown?.()
			await spawnApp()
		},
		dispose: async () => {
			serverAgent?.dispose()
			await stopApp()
			emu.dispose()
			secondEmu?.dispose()
			bm.close()
			// set SLM_KEEP_TEST_TMP=1 to retain the db + app log of a failing run
			if (!process.env.SLM_KEEP_TEST_TMP) fs.rmSync(tmpDir, { recursive: true, force: true })
		},
	}
}
