import { Mutex } from 'async-mutex'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import * as Schema from '$root/drizzle/schema'
import * as Cleanup from '@/lib/cleanup'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import * as Prom from '@/lib/promise-utils'
import * as Rx from '@/lib/rxjs'
import * as CS from '@/models/context-shared'
import * as PLG from '@/models/plugins.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as CleanupSys from '@/systems/cleanup.server'
import * as Rbac from '@/systems/rbac.server'
import * as SquadServer from '@/systems/squad-server.server'

// The plugin host: loads the installed plugins (plugins/index.server.ts), runs their migrations,
// activates/deactivates them, holds their config, and dispatches their client RPC. A plugin is
// trusted in-process code; "sandboxing" here is about lifecycle (cleanup, abort) and namespacing
// (tables, permissions), not security.

const module = initModule('plugins')
let log!: CS.Logger
const orpcBase = getOrpcBase(module)

// ---- ctx types (the P.Ctx / P.ServerCtx the plugin API exposes) ----

export type PluginRef<M extends PLG.Manifest<any> = PLG.Manifest> = { id: PLG.PluginId; manifest: M }

export type Ctx<M extends PLG.Manifest<any> = PLG.Manifest> = CS.Log &
	C.Db &
	CS.AbortSignal & {
		plugin: PluginRef<M>
		cleanup: Cleanup.Tasks
	}

export type ServerCtx<M extends PLG.Manifest<any> = PLG.Manifest> = Ctx<M> & C.ManagedServer

export type ServerSetupFn = (ctx: ServerCtx<any>, cleanup: Cleanup.Tasks) => void

export type ServerModule = { activate: (ctx: Ctx<any>) => void | Promise<void> }

export type InstalledPlugin = {
	manifest: PLG.Manifest
	server: () => Promise<ServerModule>
	migrations?: () => Promise<{ migrations: PLG.PluginMigration[] }>
	hasClient: boolean
}

// ---- runtime state ----

type RpcReg =
	| { kind: 'call'; input: z.ZodType; handler: (ctx: Ctx<any>, input: any) => Promise<unknown> }
	| { kind: 'stream'; input: z.ZodType; project: (ctx: ServerCtx<any>, input: any) => Rx.Observable<unknown> }

type Instance = {
	sctx: ServerCtx<any>
	cleanup: Cleanup.Tasks
	// which setup callbacks already ran for this instance, so the register-time sweep and the
	// server-boot hook can't double-run one
	ran: Set<ServerSetupFn>
}

type Runtime = {
	entry: InstalledPlugin
	ref: PluginRef
	log: CS.Logger
	enabled: boolean
	status: PLG.Status
	error: string | null
	// as stored: the encoded z.input shape
	configInput: Record<string, unknown>
	// decoded via the manifest schema; null while the stored config doesn't parse
	config: unknown
	cleanup: Cleanup.Tasks
	abort: AbortController | null
	serverSetups: ServerSetupFn[]
	instances: Map<string, Instance>
	rpc: Map<string, RpcReg>
}

const plugins = new Map<string, Runtime>()
// pulses a pluginId on any status/config change
export const update$ = new Rx.Subject<string>()
// serializes every enable/disable/activate transition, process-wide
const lifecycleMtx = new Mutex()

function requireRuntime(pluginId: string): Runtime {
	const rt = plugins.get(pluginId)
	if (!rt) throw new Error(`unknown plugin: ${pluginId}`)
	return rt
}

// ---- boot ----

export async function setup(ctx: C.Db, installed: InstalledPlugin[]) {
	log = module.getLogger()
	const rows = new Map(
		(await ctx.db().select().from(Schema.plugins)).map((raw) => {
			const row = unsuperjsonify(Schema.plugins, raw) as { id: string; enabled: boolean; config: Record<string, unknown> }
			return [row.id, row]
		}),
	)
	for (const entry of installed) {
		const id = entry.manifest.id
		if (plugins.has(id)) throw new Error(`duplicate plugin id: ${id}`)
		let row = rows.get(id)
		if (!row) {
			row = { id, enabled: false, config: {} }
			await ctx
				.db()
				.insert(Schema.plugins)
				.values(superjsonify(Schema.plugins, { id, enabled: false, config: {} }))
		}
		plugins.set(id, {
			entry,
			ref: { id, manifest: entry.manifest },
			log: log.child({ pluginId: id }),
			enabled: row.enabled,
			status: 'inactive',
			error: null,
			configInput: row.config ?? {},
			config: null,
			cleanup: [],
			abort: null,
			serverSetups: [],
			instances: new Map(),
			rpc: new Map(),
		})
	}
	for (const id of rows.keys()) {
		if (!plugins.has(id)) log.warn('plugin %s has a db row but is not installed; leaving its state alone', id)
	}
	for (const rt of plugins.values()) {
		if (!rt.enabled) continue
		await lifecycleMtx.runExclusive(() => activateLocked(rt))
	}
	CleanupSys.register(async () => {
		for (const rt of plugins.values()) {
			if (rt.status === 'active') await lifecycleMtx.runExclusive(() => deactivateLocked(rt))
		}
	})
}

// ---- lifecycle ----

async function activateLocked(rt: Runtime) {
	if (rt.status === 'active' || rt.status === 'activating') return
	const id = rt.ref.id
	rt.status = 'activating'
	rt.error = null
	update$.next(id)
	try {
		if (!PLG.satisfiesApiVersion(rt.entry.manifest.apiVersion)) {
			throw new Error(
				`requires slm api ${rt.entry.manifest.apiVersion}, host provides ${PLG.API_VERSION.major}.${PLG.API_VERSION.minor}`,
			)
		}
		const cfg = rt.entry.manifest.configSchema.safeParse(rt.configInput)
		if (!cfg.success) throw new Error(`invalid config:\n${z.prettifyError(cfg.error)}`)
		rt.config = cfg.data
		if (rt.entry.migrations) {
			const { migrations } = await rt.entry.migrations()
			await applyPluginMigrations(id, migrations)
		}
		const mod = await rt.entry.server()
		rt.abort = new AbortController()
		rt.cleanup = []
		await mod.activate(mkCtx(rt))
		rt.status = 'active'
		rt.log.info('plugin activated')
	} catch (err) {
		rt.log.error(err, 'plugin activation failed')
		await teardownLocked(rt)
		rt.status = 'errored'
		rt.error = err instanceof Error ? err.message : String(err)
	}
	update$.next(id)
}

async function deactivateLocked(rt: Runtime) {
	if (rt.status !== 'active' && rt.status !== 'errored') return
	rt.status = 'stopping'
	update$.next(rt.ref.id)
	await teardownLocked(rt)
	rt.status = 'inactive'
	rt.error = null
	rt.log.info('plugin deactivated')
	update$.next(rt.ref.id)
}

async function teardownLocked(rt: Runtime) {
	rt.abort?.abort()
	rt.abort = null
	// instance disposals are once-wrapped members of rt.cleanup, so this covers them too
	await Cleanup.runCleanup({ ...CS.init(), log: rt.log }, rt.cleanup)
	rt.cleanup = []
	rt.serverSetups = []
	rt.instances.clear()
	rt.rpc.clear()
	rt.config = null
}

function mkCtx(rt: Runtime): Ctx<any> {
	return {
		...DB.addPooledDb({ ...CS.init() }),
		log: rt.log,
		signal: Prom.anySignal(CleanupSys.shutdownSignal, rt.abort!.signal)!,
		plugin: rt.ref,
		cleanup: rt.cleanup,
	}
}

// ---- per-managed-server instances ----

function ensureInstance(rt: Runtime, managedServer: C.ManagedServer): Instance {
	const existing = rt.instances.get(managedServer.serverId)
	if (existing) return existing
	const cleanup: Cleanup.Tasks = []
	const sctx: ServerCtx<any> = {
		...DB.addPooledDb({ ...CS.init() }),
		...managedServer,
		log: rt.log.child({ serverId: managedServer.serverId }),
		signal: Prom.anySignal(managedServer.signal, rt.abort!.signal)!,
		plugin: rt.ref,
		cleanup,
	}
	const inst: Instance = { sctx, cleanup, ran: new Set() }
	rt.instances.set(managedServer.serverId, inst)
	// disposal runs whichever comes first, server teardown or plugin deactivation, exactly once
	let disposed = false
	const dispose = () => {
		if (disposed) return
		disposed = true
		rt.instances.delete(managedServer.serverId)
		return Cleanup.runCleanup({ ...CS.init(), log: sctx.log }, cleanup)
	}
	managedServer.cleanup.push(dispose)
	rt.cleanup.push(dispose)
	return inst
}

function invokeSetup(rt: Runtime, inst: Instance, cb: ServerSetupFn) {
	if (inst.ran.has(cb)) return
	inst.ran.add(cb)
	try {
		cb(inst.sctx, inst.cleanup)
	} catch (err) {
		inst.sctx.log.error(err, 'plugin server setup failed')
	}
}

// backs Servers.setup in the plugin API: runs cb for every managed server, now and future,
// with a cleanup scoped to that (plugin, server) pair
export function registerServerSetup(ctx: Ctx<any>, cb: ServerSetupFn) {
	const rt = requireRuntime(ctx.plugin.id)
	rt.serverSetups.push(cb)
	for (const managedServer of SquadServer.globalState.managedServers.values()) {
		invokeSetup(rt, ensureInstance(rt, managedServer), cb)
	}
}

// called from setupManagedServer, alongside the other per-server subsystem hooks
export function setupServerInstances(managedServer: C.ManagedServer) {
	for (const rt of plugins.values()) {
		if (rt.status !== 'active' && rt.status !== 'activating') continue
		if (rt.serverSetups.length === 0) continue
		const inst = ensureInstance(rt, managedServer)
		for (const cb of rt.serverSetups) invokeSetup(rt, inst, cb)
	}
}

// ---- config ----

export function getConfig<M extends PLG.Manifest<any>>(ctx: { plugin: PluginRef<M> }): PLG.Config<M> {
	const rt = requireRuntime(ctx.plugin.id)
	if (rt.config === null) throw new Error(`plugin ${ctx.plugin.id}: config read while not parsed`)
	return rt.config as PLG.Config<M>
}

// ---- rpc bridge (client <-> plugin server code) ----

export function registerRpc(ctx: Ctx<any>, name: string, reg: RpcReg) {
	const rt = requireRuntime(ctx.plugin.id)
	if (rt.rpc.has(name)) throw new Error(`plugin ${ctx.plugin.id}: rpc '${name}' registered twice`)
	rt.rpc.set(name, reg)
	ctx.cleanup.push(() => rt.rpc.delete(name))
}

// ---- plugin migrations ----

const LEDGER = '_plugin_migrations'

// Same runner contract as core migrations (BEGIN IMMEDIATE per migration, FKs off), applied at
// activation rather than boot and keyed per plugin. DDL is policed against the plugin's table
// prefix by diffing sqlite_master, so one plugin cannot quietly reshape another's (or core's) schema.
async function applyPluginMigrations(pluginId: string, migrations: PLG.PluginMigration[]) {
	const names = migrations.map((m) => m.name)
	if (new Set(names).size !== names.length) throw new Error(`plugin ${pluginId}: duplicate migration names`)
	const sorted = names.toSorted()
	if (!names.every((n, i) => n === sorted[i])) throw new Error(`plugin ${pluginId}: migrations must be listed in name order`)

	const driver = DB.rawDriver()
	driver.exec(
		`CREATE TABLE IF NOT EXISTS "${LEDGER}" (pluginId TEXT NOT NULL, name TEXT NOT NULL, applied_at INTEGER NOT NULL, PRIMARY KEY (pluginId, name))`,
	)
	const applied = new Set(
		(driver.prepare(`SELECT name FROM "${LEDGER}" WHERE pluginId = ?`).all(pluginId) as { name: string }[]).map((r) => r.name),
	)
	const pending = migrations.filter((m) => !applied.has(m.name))
	if (pending.length === 0) return

	const prefix = PLG.tablePrefix(pluginId)
	const foreignKeysWereOn = driver.pragma('foreign_keys', { simple: true }) === 1
	if (foreignKeysWereOn) driver.pragma('foreign_keys = OFF')
	try {
		const insert = driver.prepare(`INSERT INTO "${LEDGER}" (pluginId, name, applied_at) VALUES (?, ?, ?)`)
		for (const m of pending) {
			log.info('applying plugin migration %s/%s', pluginId, m.name)
			const before = snapshotSchema(driver)
			driver.exec('BEGIN IMMEDIATE')
			try {
				await m.up(driver)
				assertDdlWithinPrefix(driver, before, prefix)
				insert.run(pluginId, m.name, Date.now())
				driver.exec('COMMIT')
			} catch (err) {
				if (driver.inTransaction) driver.exec('ROLLBACK')
				throw new Error(`plugin migration ${pluginId}/${m.name} failed`, { cause: err })
			}
		}
	} finally {
		if (foreignKeysWereOn) driver.pragma('foreign_keys = ON')
	}
}

function snapshotSchema(driver: ReturnType<typeof DB.rawDriver>): Map<string, string | null> {
	const rows = driver.prepare(`SELECT type, name, sql FROM sqlite_master`).all() as {
		type: string
		name: string
		sql: string | null
	}[]
	return new Map(rows.map((r) => [`${r.type}:${r.name}`, r.sql]))
}

function assertDdlWithinPrefix(driver: ReturnType<typeof DB.rawDriver>, before: Map<string, string | null>, prefix: string) {
	const after = snapshotSchema(driver)
	const touched: string[] = []
	for (const [key, sql] of after) {
		if (before.get(key) !== sql) touched.push(key)
	}
	for (const key of before.keys()) {
		if (!after.has(key)) touched.push(key)
	}
	for (const key of touched) {
		const name = key.slice(key.indexOf(':') + 1)
		if (name.startsWith(prefix) || name.startsWith(`sqlite_autoindex_${prefix}`)) continue
		throw new Error(`DDL outside the plugin's namespace (${prefix}*): ${key}`)
	}
}

// ---- persistence ----

async function persistRow(ctx: C.Db, rt: Runtime) {
	await ctx
		.db()
		.update(Schema.plugins)
		.set(superjsonify(Schema.plugins, { enabled: rt.enabled, config: rt.configInput }))
		.where(eq(Schema.plugins.id, rt.ref.id))
}

// ---- router ----

function listRuntimeInfo(): PLG.RuntimeInfo[] {
	return [...plugins.values()].map((rt) => ({
		id: rt.ref.id,
		name: rt.entry.manifest.name,
		description: rt.entry.manifest.description,
		version: rt.entry.manifest.version,
		enabled: rt.enabled,
		status: rt.status,
		error: rt.error,
		hasClient: rt.entry.hasClient,
	}))
}

const manageReq = () => RBAC.permReq('all', [RBAC.perm('plugins:manage')])

export const router = {
	// public: every client needs to know which plugins are active to load their client entries
	watchPlugins: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ signal }) {
		const obs = update$.pipe(
			Rx.startWith(null),
			Rx.map(() => listRuntimeInfo()),
			Rx.Ext.distinctDeepEquals(),
			Rx.Ext.withAbortSignal(signal!),
		)
		yield* Rx.Ext.toAsyncGenerator(obs)
	}),

	getConfig: orpcBase.input(z.object({ pluginId: z.string() })).handler(async ({ context: ctx, input }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, manageReq())
		if (denyRes) return denyRes
		const rt = plugins.get(input.pluginId)
		if (!rt) return { code: 'err:unknown-plugin' as const }
		return { code: 'ok' as const, config: rt.configInput }
	}),

	setEnabled: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ pluginId: z.string(), enabled: z.boolean() }))
		.handler(async ({ context: ctx, input }) => {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, manageReq())
			if (denyRes) return denyRes
			const rt = plugins.get(input.pluginId)
			if (!rt) return { code: 'err:unknown-plugin' as const }
			return await lifecycleMtx.runExclusive(async () => {
				rt.enabled = input.enabled
				await persistRow(ctx, rt)
				if (input.enabled) {
					if (rt.status === 'errored') await deactivateLocked(rt)
					await activateLocked(rt)
				} else {
					await deactivateLocked(rt)
				}
				return { code: 'ok' as const, status: rt.status, error: rt.error }
			})
		}),

	updateConfig: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ pluginId: z.string(), config: z.record(z.string(), z.unknown()) }))
		.handler(async ({ context: ctx, input }) => {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, manageReq())
			if (denyRes) return denyRes
			const rt = plugins.get(input.pluginId)
			if (!rt) return { code: 'err:unknown-plugin' as const }
			const parsed = rt.entry.manifest.configSchema.safeParse(input.config)
			if (!parsed.success) return { code: 'err:invalid-config' as const, message: z.prettifyError(parsed.error) }
			rt.configInput = input.config
			// active plugins read config through getConfig on every use, so this takes effect immediately
			if (rt.status === 'active' || rt.status === 'activating') rt.config = parsed.data
			await persistRow(ctx, rt)
			update$.next(rt.ref.id)
			return { code: 'ok' as const }
		}),

	// generic dispatch for plugin-registered, per-server watch streams. Values are wrapped in
	// { code: 'ok', data } so the client can tell them from err:server-not-loaded.
	rpcStream: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ pluginId: z.string(), name: z.string(), serverId: z.string(), input: z.unknown() }))
		.handler(async function* ({ context, signal, input }) {
			const rt = plugins.get(input.pluginId)
			const reg = rt?.rpc.get(input.name)
			if (!rt || !reg || reg.kind !== 'stream') {
				yield { code: 'err:unknown-rpc' as const }
				return
			}
			const parsed = reg.input.safeParse(input.input)
			if (!parsed.success) {
				yield { code: 'err:invalid-input' as const }
				return
			}
			const obs = SquadServer.stream$(context.wsClientId, input.serverId, (serverCtx) => {
				const inst = rt.instances.get(input.serverId)
				const sctx: ServerCtx<any> = inst?.sctx ?? {
					...serverCtx,
					log: rt.log.child({ serverId: input.serverId }),
					plugin: rt.ref,
					cleanup: [],
				}
				return reg.project(sctx, parsed.data).pipe(Rx.map((data) => ({ code: 'ok' as const, data })))
			}).pipe(Rx.Ext.withAbortSignal(signal!))
			yield* Rx.Ext.toAsyncGenerator(obs)
		}),

	rpcCall: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ pluginId: z.string(), name: z.string(), input: z.unknown() }))
		.handler(async ({ input }) => {
			const rt = plugins.get(input.pluginId)
			const reg = rt?.rpc.get(input.name)
			if (!rt || !reg || reg.kind !== 'call' || rt.status !== 'active') return { code: 'err:unknown-rpc' as const }
			const parsed = reg.input.safeParse(input.input)
			if (!parsed.success) return { code: 'err:invalid-input' as const }
			return { code: 'ok' as const, data: await reg.handler(mkCtx(rt), parsed.data) }
		}),
}
