import Database from 'better-sqlite3'
import * as E from 'drizzle-orm'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import * as Schema from '$root/drizzle/schema.ts'
import * as Color from '@/lib/color'
import { tsMigrations } from '@/migrations/registry'
import * as CS from '@/models/context-shared.models'
import * as RRS from '@/models/repeat-rulesets.models'
import * as SB from '@/models/sandbox.models'
import * as SETTINGS from '@/models/settings.models'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import * as Migrate from '@/server/migrate'
import * as Sql from '@/server/sql'
import * as Seed from '@/systems/seed.server'

import * as DevInstance from '../dev/instance.ts'
import { Emulator } from '../emulator'
import { BmServer, STUB_ORG_ID } from '../emulator/bm-server.ts'
import type * as Clients from './clients.ts'

// One SLM under load: a database seeded the way a first boot seeds one, N emulated servers, the BattleMetrics stub,
// and the production server bundle spawned with production settings and poll intervals. Under `limits` the app runs
// in a transient systemd scope, whose cgroup caps its CPU and memory and reports its memory split into anon and file.

const SQL = Sql.forModule(initModule('load-instance'))

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
export const SERVER_ENTRY = path.join(REPO_ROOT, 'dist-server/main-instrumented.js')
export const CLIENT_INDEX = path.join(REPO_ROOT, 'dist/index.html')
export const LANDING_CSS = path.join(REPO_ROOT, 'dist/landing.css')
const ADMIN_LIST = 'load'
const ADMIN_GROUP = 'LoadAdmin'
const RCON_PASSWORD = 'loadpassword'
// half of production's 133ms ListPlayers round trip, as the test harness uses
const RCON_RESPONSE_LATENCY_MS = 65

export type Limits = { cpus?: number; memoryMb?: number }

export type InstanceOptions = {
	dir: string
	servers: number
	users: Clients.LoadUser[]
	// steam ids of the in-game admins, per server
	adminSteamIds: (serverIndex: number) => string[]
	limits: Limits
	otelEndpoint?: string
	// extra variables for the app's environment, such as MALLOC_ARENA_MAX
	appEnv?: Record<string, string>
	// an existing database to boot on instead of a fresh one, such as one seed-history.ts filled
	db?: string
}

export type Instance = {
	appUrl: string
	dbPath: string
	logFile: string
	serverIds: string[]
	emulators: Emulator[]
	child: childProcess.ChildProcess
	// the cgroup the app runs in, when it runs under limits
	cgroupDir: string | null
	control: (command: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
	dispose: () => Promise<void>
}

export const serverIdAt = (i: number) => `load-${i + 1}`

export async function start(opts: InstanceOptions): Promise<Instance> {
	DevInstance.ensureLayerData()
	fs.mkdirSync(opts.dir, { recursive: true })
	const dbPath = path.join(opts.dir, 'db.sqlite3')
	const logFile = path.join(opts.dir, 'app.log')
	// a unix socket path is capped at 108 bytes, which a run directory can exceed
	const controlSocket = path.join(os.tmpdir(), `slm-load-${process.pid}-${Date.now().toString(36)}.sock`)
	const serverIds = Array.from({ length: opts.servers }, (_, i) => serverIdAt(i))

	const emulators = await Promise.all(
		serverIds.map((id) =>
			new Emulator({ serverName: id, password: RCON_PASSWORD, idSalt: id, rconResponseLatencyMs: RCON_RESPONSE_LATENCY_MS }).start(),
		),
	)
	const bm = new BmServer({ registerOnLookup: true })
	const bmPort = await bm.listen()

	const logPaths = serverIds.map((id) => path.join(opts.dir, `${id}.SquadGame.log`))
	for (const p of logPaths) fs.writeFileSync(p, '')
	emulators.forEach((emu, i) => emu.attachLogFile(logPaths[i]))
	const adminsCfgPaths = serverIds.map((id) => path.join(opts.dir, `${id}.Admins.cfg`))
	serverIds.forEach((_, i) => {
		fs.writeFileSync(
			adminsCfgPaths[i],
			SB.renderAdminsCfgGroup(ADMIN_GROUP, ['canseeadminchat', 'balance', 'teamchange'], opts.adminSteamIds(i)),
		)
	})

	if (opts.db) {
		for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true })
		fs.copyFileSync(opts.db, dbPath)
	}
	const driver = new Database(dbPath)
	driver.pragma('journal_mode = WAL')
	try {
		await Migrate.runMigrations(driver, { sqlDir: path.join(REPO_ROOT, 'drizzle-sqlite'), tsMigrations })
		// connections, users and admin lists are rewritten on every boot, since ports and paths change between runs
		configure(driver, {
			serverIds,
			users: opts.users,
			rconPorts: emulators.map((e) => e.rconPort),
			logPaths,
			adminsCfgPaths,
			fresh: !opts.db,
		})
	} finally {
		driver.close()
	}

	// The kernel charges a page of page cache to the cgroup that first read it, which for the database is this process,
	// having just copied and configured it. Dropped here, so that the app reads its database in and is charged for it,
	// as it is in production.
	evictFromPageCache(dbPath)
	const port = await freePort()
	const appUrl = `http://127.0.0.1:${port}`
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '',
		HOME: process.env.HOME ?? '',
		DEMO: 'true',
		NODE_ENV: 'production',
		DB_PATH: dbPath,
		DB_AUTOMIGRATE: 'false',
		PORT: String(port),
		HOST: '127.0.0.1',
		ORIGIN: appUrl,
		DISCORD_ENABLED: 'false',
		BM_HOST: `http://127.0.0.1:${bmPort}`,
		CONTROL_SOCKET: controlSocket,
		LOCAL_ADMIN_LISTS_DIR: opts.dir,
		PLUGINS_DIR: path.join(opts.dir, 'plugins'),
		...(opts.otelEndpoint
			? {
					OTEL_ENABLED: 'true',
					OTLP_COLLECTOR_ENDPOINT: opts.otelEndpoint,
					OTEL_RESOURCE_ATTRIBUTES: 'service.name=slm-load,deployment.environment.name=load',
				}
			: { OTEL_ENABLED: 'false' }),
		...opts.appEnv,
	}

	const nodeArgs = [
		'--import',
		path.join(REPO_ROOT, 'register-source-maps.mjs'),
		'--import',
		path.join(REPO_ROOT, 'register-otel.mjs'),
		SERVER_ENTRY,
	]
	const limited = opts.limits.cpus !== undefined || opts.limits.memoryMb !== undefined
	const [command, args] = limited ? systemdScope(opts.limits, ['node', ...nodeArgs]) : ['node', nodeArgs]
	// systemd-run reaches the user's service manager through these, and passes them on to the app, which ignores them
	if (limited) {
		for (const key of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[key]) env[key] = process.env[key]
	}
	const out = fs.openSync(logFile, 'a')
	const child = childProcess.spawn(command, args, { cwd: REPO_ROOT, env, stdio: ['ignore', out, out] })
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
		child.once('exit', (code, signal) => resolve({ code, signal })),
	)

	const control = (command: string, args?: Record<string, unknown>) => controlRequest(controlSocket, command, args)

	await waitUntil(async () => {
		if (child.exitCode !== null) throw new Error(`the app exited during boot (code ${child.exitCode}); see ${logFile}`)
		return (await fetch(`${appUrl}/check-auth`).catch(() => null)) !== null
	}, 120_000)
	// a scope execs its command in place, so the child is the app
	const cgroupDir = limited ? cgroupOf(child.pid!) : null

	return {
		appUrl,
		dbPath,
		logFile,
		serverIds,
		emulators,
		child,
		cgroupDir,
		control,
		exited,
		dispose: async () => {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGTERM')
				const kill = setTimeout(() => child.kill('SIGKILL'), 10_000)
				await exited
				clearTimeout(kill)
			}
			for (const emu of emulators) emu.dispose()
			bm.close()
		},
	}
}

export type DbLayout = {
	serverIds: string[]
	users: Clients.LoadUser[]
	rconPorts: number[]
	logPaths: string[]
	adminsCfgPaths: string[]
	// a database no boot has configured yet, which gets what a first boot seeds
	fresh: boolean
}

// Points the database at this run's emulators, admin lists and users, creating whatever is missing.
export function configure(driver: Database.Database, opts: DbLayout) {
	const ctx = { ...CS.init(), db: DB.connect(driver) }
	if (opts.fresh) Seed.setup(ctx)
	// statements built per call: this runs once per boot

	const existing = DB.get(ctx, SQL.select().from(Schema.globalSettings))
	let globalSettings: SETTINGS.GlobalSettings
	if (existing) {
		globalSettings = SETTINGS.GlobalSettingsSchema.parse(existing.settings)
	} else {
		const defaults = SETTINGS.parseGlobalSettings({})
		if (!defaults.success) throw new Error('default global settings failed schema validation', { cause: defaults.error })
		globalSettings = Seed.applyInitialGlobalSettings(defaults.data)
	}
	const rulesets = [...globalSettings.repeatRulesets]
	for (const id of opts.serverIds) {
		if (rulesets.some((r) => r.ownerServerId === id)) continue
		rulesets.push({
			id: RRS.ownIdForServer(rulesets, id),
			name: RRS.freeName(rulesets, id),
			ownerServerId: id,
			rules: [...RRS.DEFAULT_RULES],
		})
	}
	globalSettings = {
		...globalSettings,
		repeatRulesets: rulesets,
		integrations: {
			battlemetrics: { enabled: true, token: 'load', orgId: STUB_ORG_ID },
			squadBrowser: { enabled: true, token: '' },
			steam: { enabled: true, token: '' },
		},
		seedSandboxServer: false,
		adminLists: Object.fromEntries(
			opts.serverIds.map((id, i) => [
				`${ADMIN_LIST}-${id}`,
				{
					source: { type: 'local' as const, source: opts.adminsCfgPaths[i] },
					adminIdentifyingPermissions: ['canseeadminchat' as const],
				},
			]),
		),
	}
	DB.run(ctx, SQL.delete(Schema.globalSettings))
	DB.run(ctx, SQL.insert(Schema.globalSettings).values({ id: 1, settings: SETTINGS.GlobalSettingsSchema.encode(globalSettings) }))

	opts.serverIds.forEach((id, i) => {
		const connections: SETTINGS.ServerConnection = {
			type: 'local',
			logFile: opts.logPaths[i],
			rcon: { host: '127.0.0.1', port: opts.rconPorts[i], password: RCON_PASSWORD },
		}
		const row = DB.get(
			ctx,
			SQL.select()
				.from(Schema.servers)
				.where(E.eq(Schema.servers.id, SQL.lit(id))),
		)
		const base = row
			? SETTINGS.ServerSettingsSchema.parse(row.settings)
			: Seed.applyInitialPoolConfig(SETTINGS.ServerSettingsSchema.parse({ color: Color.pickDistinct([]), connections }))
		const settings = { ...base, connections, adminLists: [`${ADMIN_LIST}-${id}`] }
		settings.queue.mainPool.repeatRulesetId = rulesets.find((r) => r.ownerServerId === id)!.id
		if (row) {
			DB.run(
				ctx,
				SQL.update(Schema.servers)
					.set({ settings, enabled: SQL.lit(true) })
					.where(E.eq(Schema.servers.id, SQL.lit(id))),
			)
		} else {
			DB.run(ctx, SQL.insert(Schema.servers).values({ id, displayName: id, enabled: true, defaultServer: i === 0, settings }))
		}
	})
	// servers a previous run left that this one does not drive
	for (const row of DB.all(ctx, SQL.select({ id: Schema.servers.id }).from(Schema.servers))) {
		if (opts.serverIds.includes(row.id)) continue
		DB.run(
			ctx,
			SQL.update(Schema.servers)
				.set({ enabled: SQL.lit(false) })
				.where(E.eq(Schema.servers.id, SQL.lit(row.id))),
		)
	}

	for (const u of opts.users) {
		DB.run(
			ctx,
			SQL.insert(Schema.discordAccounts)
				.values({ discordId: u.discordId, username: u.username, updatedAt: new Date() })
				.onConflictDoNothing(),
		)
		DB.run(ctx, SQL.insert(Schema.users).values({ discordId: u.discordId }).onConflictDoNothing())
	}
}

// GNU dd's nocache flag drops a file's clean pages from the page cache; the fdatasync makes every page clean first
function evictFromPageCache(file: string) {
	const res = childProcess.spawnSync('dd', ['if=/dev/null', `of=${file}`, 'oflag=nocache', 'conv=notrunc,fdatasync', 'count=0'])
	if (res.status !== 0) throw new Error(`could not drop ${file} from the page cache: ${res.stderr.toString()}`)
}

// CPUQuota is a share of one core, so 1.5 cpus is 150%. Swap is off, or a memory cap would page instead of kill.
function systemdScope(limits: Limits, cmd: string[]): [string, string[]] {
	const props: string[] = []
	if (limits.cpus !== undefined) props.push('-p', `CPUQuota=${Math.round(limits.cpus * 100)}%`)
	if (limits.memoryMb !== undefined) props.push('-p', `MemoryMax=${limits.memoryMb}M`, '-p', 'MemorySwapMax=0')
	return ['systemd-run', ['--user', '--scope', '--quiet', '--collect', ...props, ...cmd]]
}

function cgroupOf(pid: number): string {
	const line = fs
		.readFileSync(`/proc/${pid}/cgroup`, 'utf8')
		.trim()
		.split('\n')
		.find((l) => l.startsWith('0::'))
	if (!line) throw new Error(`pid ${pid} has no cgroup v2 entry`)
	return path.join('/sys/fs/cgroup', line.slice(3))
}

async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const srv = net.createServer()
		srv.once('error', reject)
		srv.listen(0, '127.0.0.1', () => {
			const port = (srv.address() as net.AddressInfo).port
			srv.close(() => resolve(port))
		})
	})
}

async function waitUntil(probe: () => Promise<boolean>, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (await probe()) return
		await new Promise((r) => setTimeout(r, 250))
	}
	throw new Error(`timed out after ${timeoutMs}ms`)
}

function controlRequest(socketPath: string, command: string, args?: Record<string, unknown>) {
	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const socket = net.createConnection(socketPath)
		let buffer = ''
		socket.setEncoding('utf8')
		socket.on('connect', () => socket.write(JSON.stringify({ command, args }) + '\n'))
		socket.on('data', (chunk: string) => (buffer += chunk))
		socket.on('error', reject)
		socket.on('close', () => {
			try {
				resolve(JSON.parse(buffer) as Record<string, unknown>)
			} catch (err) {
				reject(err)
			}
		})
	})
}
