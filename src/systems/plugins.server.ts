import { type AnyRouter, createRouterClient } from '@orpc/server'
import { Mutex } from 'async-mutex'
import { eq } from 'drizzle-orm'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'

import * as Schema from '$root/drizzle/schema'
import * as Cleanup from '@/lib/cleanup'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import * as Prom from '@/lib/promise-utils'
import * as Rx from '@/lib/rxjs'
import * as CS from '@/models/context-shared'
import type * as LQ from '@/models/layer-queue.models'
import type * as MH from '@/models/match-history.models'
import type * as Msgs from '@/models/messages.models'
import * as PLG from '@/models/plugins.models'
import type * as SETTINGS from '@/models/settings.models'
import type * as SQS from '@/models/squad-server.models'
import * as RBAC from '@/rbac.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as CleanupSys from '@/systems/cleanup.server'
import * as ApiRegistry from '@/systems/plugin-api-registry.server'
import * as Pkgs from '@/systems/plugin-packages.server'
import * as Rbac from '@/systems/rbac.server'
import * as SquadServer from '@/systems/squad-server.server'

// The plugin host: loads the installed plugins, runs their migrations, activates/deactivates them,
// holds their config, and dispatches their client RPC. A plugin is trusted in-process code;
// "sandboxing" here is about lifecycle (cleanup, abort) and namespacing (tables, permissions), not
// security -- a plugin can do anything the app can.
//
// Plugins arrive two ways. Builtins are registered statically from plugins/index.server.ts and live
// in the app bundle. Packaged plugins are directories under data/plugins (see
// plugin-packages.server.ts), loaded as standalone esm at runtime, which is what install-from-url
// and refresh act on. Both end up as the same Entry.

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

// The plugin-facing slice of a managed server: the domains the slm/* entries expose functions for.
// The runtime object is the full C.ManagedServer, so widening this later is additive; vote,
// teamswaps, switch-requests and the match-events cache are deliberately not in the contract yet.
export type ServerCtx<M extends PLG.Manifest<any> = PLG.Manifest> = Ctx<M> & SQS.Ctx & MH.Ctx & LQ.Ctx & SETTINGS.Ctx & Msgs.Ctx

export type ServerSetupFn = (ctx: ServerCtx<any>, cleanup: Cleanup.Tasks) => void

// A packaged plugin's migrations ride along with its server bundle; a builtin keeps them in their own
// module, reached through InstalledPlugin.migrations.
export type ServerModule = { activate: (ctx: Ctx<any>) => void | Promise<void>; migrations?: PLG.PluginMigration[] }

// how a builtin registers itself (plugins/index.server.ts)
export type InstalledPlugin = {
	manifest: PLG.Manifest
	server: () => Promise<ServerModule>
	migrations?: () => Promise<{ migrations: PLG.PluginMigration[] }>
	hasClient: boolean
}

// a builtin or a package, normalized
type Entry = {
	manifest: PLG.Manifest
	server: () => Promise<ServerModule>
	migrations?: () => Promise<{ migrations: PLG.PluginMigration[] }>
	hasClient: boolean
	source: PLG.Source
	sourceUrl: string | null
	// asset urls the browser imports, hash-stamped; null for a builtin
	manifestEntry: string | null
	clientEntry: string | null
	// the package this came from, for refresh and for noticing an upgraded bundle
	pkg: Pkgs.Package | null
}

// ---- runtime state ----

type Instance = {
	sctx: ServerCtx<any>
	cleanup: Cleanup.Tasks
	// which setup callbacks already ran for this instance, so the register-time sweep and the
	// server-boot hook can't double-run one
	ran: Set<ServerSetupFn>
}

type Runtime = {
	entry: Entry
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
	// the plugin's oRPC router, registered at activation. Procedures receive a ServerCtx.
	router: AnyRouter | null
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

// A package that would not load, kept so the settings page can say why instead of silently omitting
// it. plugin.json is enough to name it; what failed is the manifest module or the package itself.
type BrokenPackage = { manifest: PLG.PackageManifest; error: string; source: PLG.Source; sourceUrl: string | null }
const brokenPackages = new Map<string, BrokenPackage>()

export async function setup(ctx: C.Db, builtins: InstalledPlugin[]) {
	log = module.getLogger()
	// before any package is imported: this is what makes `slm/*` resolve inside one
	ApiRegistry.setup()
	Pkgs.setup()

	for (const builtin of builtins) {
		await ensureRuntime(ctx, { ...builtin, source: 'builtin', sourceUrl: null, manifestEntry: null, clientEntry: null, pkg: null })
	}
	await loadPackages(ctx)

	const known = new Set(plugins.keys())
	for (const raw of await ctx.db().select().from(Schema.plugins)) {
		const row = unsuperjsonify(Schema.plugins, raw) as { id: string }
		if (!known.has(row.id)) log.warn('plugin %s has a db row but is not installed; leaving its state alone', row.id)
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

// Creates the runtime for an entry, seeding it from the plugin's row (inserting one the first time
// it is seen). Config survives an uninstall, so reinstalling a plugin keeps its settings.
async function ensureRuntime(ctx: C.Db, entry: Entry): Promise<Runtime> {
	const id = entry.manifest.id
	if (plugins.has(id)) throw new Error(`duplicate plugin id: ${id}`)
	const [raw] = await ctx.db().select().from(Schema.plugins).where(eq(Schema.plugins.id, id))
	let row = raw ? (unsuperjsonify(Schema.plugins, raw) as { id: string; enabled: boolean; config: Record<string, unknown> }) : undefined
	if (!row) {
		row = { id, enabled: false, config: {} }
		await ctx
			.db()
			.insert(Schema.plugins)
			.values(superjsonify(Schema.plugins, { id, enabled: false, config: {} }))
	}
	const rt: Runtime = {
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
		router: null,
	}
	plugins.set(id, rt)
	return rt
}

// ---- packages ----

// Counts activations across all plugins, so each one loads its server bundle under a url nothing has
// used before.
let activationSeq = 0

// The bundle url carries its content hash, so an upgraded package is a different module. `activation`
// additionally makes every start a different module: esm caches by url, so without it a stop/start
// would re-run activate() against whatever the previous run left in module scope, and "restart"
// would not mean restart. Both leave the old graph resident -- node's module map has no eviction and
// V8 only drops the compilation cache under a GC it never runs on its own -- which is the price.
// Builtins cannot do this: their modules are in the app bundle, so their module scope is per-process.
function moduleUrl(filePath: string, assetId: string, activation?: number): string {
	const url = `${pathToFileURL(filePath).href}?v=${assetId}`
	return activation === undefined ? url : `${url}&a=${activation}`
}

function assetUrl(id: string, rel: string, assetId: string): string {
	return `/plugin-assets/${id}/${rel}?v=${assetId}`
}

async function entryFromPackage(pkg: Pkgs.Package): Promise<Entry> {
	const mod = (await import(moduleUrl(pkg.manifestPath, pkg.manifestAssetId))) as { default?: PLG.Manifest }
	const manifest = mod.default
	if (!manifest || typeof manifest !== 'object' || manifest.id !== pkg.id) {
		throw new Error(`${pkg.manifest.manifest} must default-export the manifest definePlugin() returned, with id '${pkg.id}'`)
	}
	return {
		manifest,
		server: async () => (await import(moduleUrl(pkg.serverPath, pkg.serverAssetId, ++activationSeq))) as ServerModule,
		hasClient: pkg.clientPath !== null,
		source: pkg.install ? 'url' : 'directory',
		sourceUrl: pkg.install?.sourceUrl ?? null,
		manifestEntry: assetUrl(pkg.id, pkg.manifest.manifest, pkg.manifestAssetId),
		clientEntry: pkg.clientPath ? assetUrl(pkg.id, pkg.manifest.client!, pkg.clientAssetId!) : null,
		pkg,
	}
}

async function loadPackages(ctx: C.Db) {
	brokenPackages.clear()
	for (const pkg of Pkgs.scan()) {
		try {
			if (plugins.has(pkg.id)) throw new Error(`a builtin plugin already uses the id '${pkg.id}'`)
			await ensureRuntime(ctx, await entryFromPackage(pkg))
		} catch (err) {
			log.error(err, 'plugin package %s failed to load', pkg.id)
			brokenPackages.set(pkg.id, {
				manifest: pkg.manifest,
				error: err instanceof Error ? err.message : String(err),
				source: pkg.install ? 'url' : 'directory',
				sourceUrl: pkg.install?.sourceUrl ?? null,
			})
		}
	}
}

// Re-reads the plugins directory: picks up new directories, drops removed ones, and reloads a
// package whose bundles changed on disk. An affected plugin is stopped first and restarted after if
// it was enabled, since a reloaded package is a different module graph.
export async function reloadPackages(ctx: C.Db) {
	await lifecycleMtx.runExclusive(async () => {
		const found = new Map(Pkgs.scan().map((pkg) => [pkg.id, pkg]))
		for (const rt of [...plugins.values()]) {
			const old = rt.entry.pkg
			if (!old) continue
			const next = found.get(rt.ref.id)
			if (next && !changed(old, next)) continue
			await deactivateLocked(rt)
			plugins.delete(rt.ref.id)
		}
		await loadPackages(ctx)
		for (const rt of plugins.values()) {
			if (rt.enabled && rt.status === 'inactive') await activateLocked(rt)
		}
	})
	update$.next('*')
}

function changed(a: Pkgs.Package, b: Pkgs.Package): boolean {
	return a.manifestAssetId !== b.manifestAssetId || a.serverAssetId !== b.serverAssetId || a.clientAssetId !== b.clientAssetId
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
		// the module body is inert (a plugin does its work in activate), so loading it first to reach a
		// package's migrations costs nothing
		const mod = await rt.entry.server()
		const migrations = rt.entry.migrations ? (await rt.entry.migrations()).migrations : (mod.migrations ?? [])
		if (migrations.length > 0) await applyPluginMigrations(id, migrations)
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
	rt.router = null
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
	// The instance ends when the server goes down or the plugin stops, whichever comes first, so its own
	// task list is registered with both. Task lists nest, so no wrapper is needed, and draining either
	// one empties the list: the second finds nothing to run, and neither is left holding what the
	// plugin's tasks captured.
	const serverId = managedServer.serverId
	cleanup.push(() => rt.instances.delete(serverId))
	managedServer.cleanup.push(cleanup)
	rt.cleanup.push(cleanup)
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

/**
 * The plugin's current config, decoded through its manifest schema. Always reflects the latest saved
 * value, so read it where you use it rather than snapshotting at activation. Throws if the plugin is
 * not active.
 */
export function getConfig<M extends PLG.Manifest<any>>(ctx: { plugin: PluginRef<M> }): PLG.Config<M> {
	const rt = requireRuntime(ctx.plugin.id)
	if (rt.config === null) throw new Error(`plugin ${ctx.plugin.id}: config read while not parsed`)
	return rt.config as PLG.Config<M>
}

// ---- rpc bridge (client <-> plugin server code) ----

export function registerRouter(ctx: Ctx<any>, router: AnyRouter) {
	const rt = requireRuntime(ctx.plugin.id)
	if (rt.router) throw new Error(`plugin ${ctx.plugin.id}: a router is already registered`)
	rt.router = router
	ctx.cleanup.push(() => (rt.router = null))
}

// Resolves a procedure by path against the plugin's router and calls it with a per-server ctx. The
// same entry point for both transports: what differs is whether the result is awaited or iterated.
function callProcedure(rt: Runtime, sctx: ServerCtx<any>, path: readonly string[], input: unknown): Promise<unknown> {
	const client = createRouterClient(rt.router!, { context: sctx })
	let target: unknown = client
	for (const key of path) {
		target = (target as Record<string, unknown> | undefined)?.[key]
	}
	if (typeof target !== 'function') throw new Error(`plugin ${rt.ref.id}: no procedure at '${path.join('.')}'`)
	return (target as (input: unknown) => Promise<unknown>)(input)
}

// the ctx a plugin procedure runs with: the live per-server instance when the plugin has one, a
// throwaway otherwise, so a call still works while the plugin has registered no server setups
function procedureCtx(rt: Runtime, serverCtx: C.Db & C.ManagedServer, serverId: string): ServerCtx<any> {
	const instance = rt.instances.get(serverId)
	if (instance) return instance.sctx
	const fallback: ServerCtx<any> = {
		...serverCtx,
		log: rt.log.child({ serverId }),
		signal: Prom.anySignal(serverCtx.signal, rt.abort?.signal)!,
		plugin: rt.ref,
		cleanup: [],
	}
	return fallback
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
	const loaded = [...plugins.values()].map((rt) => ({
		id: rt.ref.id,
		name: rt.entry.manifest.name,
		description: rt.entry.manifest.description,
		version: rt.entry.manifest.version,
		enabled: rt.enabled,
		status: rt.status,
		error: rt.error,
		hasClient: rt.entry.hasClient,
		source: rt.entry.source,
		sourceUrl: rt.entry.sourceUrl,
		manifestEntry: rt.entry.manifestEntry,
		clientEntry: rt.entry.clientEntry,
	}))
	const broken = [...brokenPackages].map(([id, pkg]): PLG.RuntimeInfo => ({
		id,
		name: pkg.manifest.name,
		description: pkg.manifest.description,
		version: pkg.manifest.version,
		enabled: false,
		status: 'errored',
		error: pkg.error,
		hasClient: false,
		source: pkg.source,
		sourceUrl: pkg.sourceUrl,
		manifestEntry: null,
		clientEntry: null,
	}))
	return [...loaded, ...broken].toSorted((a, b) => (a.name < b.name ? -1 : 1))
}

// a hand-run install should not hang forever on a url that never answers
const FETCH_BUDGET_MS = 60_000

const manageReq = () => RBAC.permReq('all', [RBAC.perm('plugins:manage')])

// The only two files a browser may fetch out of a package: its manifest module and its client
// bundle. Matching against the names plugin.json declares is what keeps the server bundle (and
// everything else on disk) unreachable.
export function servableAsset(pluginId: string, rel: string): string | null {
	const pkg = plugins.get(pluginId)?.entry.pkg
	if (!pkg) return null
	if (rel === pkg.manifest.manifest) return pkg.manifestPath
	if (pkg.manifest.client && rel === pkg.manifest.client) return pkg.clientPath
	return null
}

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
	// Generic dispatch for a plugin's streaming procedures. Values are wrapped in { code: 'ok', data }
	// so the client can tell them from err:server-not-loaded, and the projection is re-entered when the
	// managed server reappears, so a server coming back self-heals the stream.
	rpcStream: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ pluginId: z.string(), path: z.array(z.string()).min(1), serverId: z.string(), input: z.unknown() }))
		.handler(async function* ({ context, signal, input }) {
			const rt = plugins.get(input.pluginId)
			if (!rt?.router) {
				yield { code: 'err:unknown-rpc' as const }
				return
			}
			const obs = SquadServer.stream$(context.wsClientId, input.serverId, (serverCtx) =>
				Rx.defer(() => callProcedure(rt, procedureCtx(rt, serverCtx, input.serverId), input.path, input.input)).pipe(
					Rx.switchMap((result) => Rx.from(result as AsyncIterable<unknown>)),
					Rx.map((data) => ({ code: 'ok' as const, data })),
				),
			).pipe(Rx.Ext.withAbortSignal(signal!))
			yield* Rx.Ext.toAsyncGenerator(obs)
		}),

	installFromUrl: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ url: z.url() }))
		.handler(async ({ context: ctx, input, signal }) => {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, manageReq())
			if (denyRes) return denyRes
			const res = await Pkgs.installFromUrl({ signal: signal ?? AbortSignal.timeout(FETCH_BUDGET_MS) }, input.url)
			if (res.code !== 'ok') return res
			await reloadPackages(ctx)
			return { code: 'ok' as const, pluginId: res.pkg.id }
		}),

	// re-fetches a url-installed package from the source it recorded, and reloads it if the bundles moved
	refresh: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ pluginId: z.string() }))
		.handler(async ({ context: ctx, input, signal }) => {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, manageReq())
			if (denyRes) return denyRes
			const pkg = Pkgs.scan().find((p) => p.id === input.pluginId)
			if (!pkg) return { code: 'err:unknown-plugin' as const }
			const res = await Pkgs.refresh({ signal: signal ?? AbortSignal.timeout(FETCH_BUDGET_MS) }, pkg)
			if (res.code !== 'ok') return res
			await reloadPackages(ctx)
			return { code: 'ok' as const, pluginId: res.pkg.id }
		}),

	// picks up whatever is in the plugins directory now: a hand-placed package, or a rebuilt bundle
	rescan: orpcBase.meta({ type: 'mutation' }).handler(async ({ context: ctx }) => {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, manageReq())
		if (denyRes) return denyRes
		await reloadPackages(ctx)
		return { code: 'ok' as const }
	}),

	// removes the directory. The plugin's row and its tables stay, so reinstalling keeps its config
	// and its data.
	uninstall: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ pluginId: z.string() }))
		.handler(async ({ context: ctx, input }) => {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, manageReq())
			if (denyRes) return denyRes
			const rt = plugins.get(input.pluginId)
			if (rt && rt.entry.source === 'builtin') return { code: 'err:builtin' as const }
			if (!rt && !brokenPackages.has(input.pluginId)) return { code: 'err:unknown-plugin' as const }
			await Pkgs.remove(input.pluginId)
			await reloadPackages(ctx)
			return { code: 'ok' as const }
		}),

	rpcCall: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ pluginId: z.string(), path: z.array(z.string()).min(1), serverId: z.string(), input: z.unknown() }))
		.handler(async ({ context, input }) => {
			const rt = plugins.get(input.pluginId)
			if (!rt?.router || rt.status !== 'active') return { code: 'err:unknown-rpc' as const }
			const managedServer = SquadServer.globalState.managedServers.get(input.serverId)
			if (!managedServer) return { code: 'err:server-not-loaded' as const }
			const sctx = procedureCtx(rt, { ...DB.addPooledDb({ ...CS.init() }), ...managedServer }, input.serverId)
			return { code: 'ok' as const, data: await callProcedure(rt, sctx, input.path, input.input) }
		}),
}
