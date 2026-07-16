import * as Schema from '$root/drizzle/schema.ts'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async.ts'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import * as Obj from '@/lib/object'
import { diffSettings, type SettingChange } from '@/lib/settings-diff'
import { assertNever } from '@/lib/type-guards'
import * as AppEvents from '@/models/app-events.models'
import * as SS from '@/models/server-state.models'
import * as SETTINGS from '@/models/settings.models'
import * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models.ts'
import type * as C from '@/server/context.ts'
import * as DB from '@/server/db.ts'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as SecretBox from '@/server/secret-box.server'
import * as AppEventsSys from '@/systems/app-events.server'
import * as Rbac from '@/systems/rbac.server'
import * as SquadServer from '@/systems/squad-server.server'
import * as Orpc from '@orpc/server'
import * as E from 'drizzle-orm'
import * as Rx from 'rxjs'
import { z } from 'zod'

const module = initModule('settings')
let log!: ReturnType<typeof module.getLogger>
const orpcBase = getOrpcBase(module)

export async function setup(ctx: C.Db) {
	log = module.getLogger()
	await loadGlobalSettings(ctx)
	await loadServerRegistry(ctx)
}

// ============================== global settings ==============================

export let GLOBAL_SETTINGS!: SETTINGS.GlobalSettings

async function loadGlobalSettings(ctx: C.Db) {
	const rows = await ctx.db().select().from(Schema.globalSettings)
	if (rows.length === 0) {
		// fresh install: schema defaults include the tiered admins/managers/owners RBAC preset (see defaultRbacSettings)
		const defaultsRes = SETTINGS.parseGlobalSettings({})
		if (!defaultsRes.success) throw new Error('Default global settings failed schema validation', { cause: defaultsRes.error })
		const defaults = defaultsRes.data
		await ctx.db().insert(Schema.globalSettings).values(
			superjsonify(Schema.globalSettings, { id: 1, settings: SETTINGS.GlobalSettingsSchema.encode(defaults) }),
		)
		GLOBAL_SETTINGS = defaults
		log.info('Created default global settings row')
	} else {
		const raw = unsuperjsonify(Schema.globalSettings, rows[0]) as any
		// seeds any command this installation's settings predate (see SETTINGS.parseGlobalSettings)
		const parseRes = SETTINGS.parseGlobalSettings(raw.settings)
		if (!parseRes.success) {
			// refuse to start rather than silently reset to defaults: a validation failure means either a bad manual
			// edit or a breaking schema change with a missing/incorrect migration, and booting on defaults would quietly
			// discard the real config (and can mask downstream .encode() failures, see the layerTable codec regression)
			log.fatal(
				parseRes.error,
				'Global settings in DB failed schema validation; refusing to start. Repair the globalSettings row or add a migration.',
			)
			throw new Error('Global settings in DB failed schema validation', { cause: parseRes.error })
		}
		GLOBAL_SETTINGS = parseRes.data
		log.info('Loaded global settings from DB')
	}
	Rbac.applyRbacSettings(GLOBAL_SETTINGS.rbac)
	settings$.next({ scope: 'global', settings: GLOBAL_SETTINGS })
}

export async function updateGlobalSettings(
	ctx: C.Db,
	input: Record<string, unknown>,
	access: RBAC.SettingsWriteAccess = { kind: 'all' },
) {
	const merged = { ...GLOBAL_SETTINGS, ...input }
	const parseRes = SETTINGS.parseGlobalSettings(merged)
	if (!parseRes.success) {
		return { code: 'err:invalid-settings' as const, message: parseRes.error.message }
	}

	const changes = diffSettings(GLOBAL_SETTINGS, parseRes.data)

	// path-restricted writers may only change settings under their granted prefixes; the denied paths ride
	// along in the permit args so the caller can see exactly what was out of bounds
	if (access.kind !== 'all') {
		const deniedPaths = changes
			.map((c) => c.path)
			.filter((p) => !RBAC.settingsPathAllowed(access, p))
		if (deniedPaths.length > 0) {
			return RBAC.permissionDenied({ check: 'all' as const, permits: [RBAC.perm('global-settings:write', { paths: deniedPaths })] })
		}
	}

	GLOBAL_SETTINGS = parseRes.data
	await ctx.db({ redactParams: true })
		.update(Schema.globalSettings)
		.set(superjsonify(Schema.globalSettings, { settings: SETTINGS.GlobalSettingsSchema.encode(GLOBAL_SETTINGS) }))
	Rbac.applyRbacSettings(GLOBAL_SETTINGS.rbac)
	settings$.next({ scope: 'global', settings: GLOBAL_SETTINGS })
	log.info('Global settings updated')
	return { code: 'ok' as const, changes }
}

// what the audit log is allowed to remember about a settings change: everything except the values of the rcon/sftp
// credentials. toRow redacts these again on the way to the table; doing it here as well keeps the in-flight event
// (which gets logged and traced) clean too.
function auditableSettingChanges(changes: SettingChange[]): AppEvents.SettingsUpdated['changes'] {
	return AppEvents.redactSettingChanges(changes)
}

// ============================== server registry: identity + enabled/default/broken status for every known server ==============================

export type ServerEntry = {
	id: SS.ServerId
	displayName: string
	defaultServer: boolean
	enabled: boolean
	// true if the stored settings for this server failed schema validation (e.g. after a breaking change); it won't have a live slice until repaired
	broken: boolean
}

const serverRegistry = new Map<SS.ServerId, ServerEntry>()

export function listServerEntries(): ServerEntry[] {
	return [...serverRegistry.values()]
}

export function getServerEntry(serverId: SS.ServerId): ServerEntry | undefined {
	return serverRegistry.get(serverId)
}

export function hasServerEntry(serverId: SS.ServerId): boolean {
	return serverRegistry.has(serverId)
}

async function loadServerRegistry(ctx: C.Db) {
	const rows = await ctx.db().select().from(Schema.servers)
	for (const rawRow of rows) {
		const row = unsuperjsonify(Schema.servers, rawRow) as {
			id: SS.ServerId
			displayName: string
			enabled: boolean
			defaultServer: boolean
			settings: unknown
		}
		const settingsRes = SETTINGS.ServerSettingsSchema.safeParse(row.settings)
		let broken = !settingsRes.success
		let brokenReason: unknown = settingsRes.success ? undefined : settingsRes.error
		if (settingsRes.success) {
			// backfill: bring connection secrets up to the current encryption scheme -- plaintext ones from before
			// encryption existed, and v1 envelopes from before the key derivation changed. A no-op on every boot
			// once each row has been rewritten.
			try {
				if (connectionsNeedReseal(settingsRes.data)) {
					const sealed = resealConnections(settingsRes.data)
					await ctx.db({ redactParams: true }).update(Schema.servers).set(superjsonify(Schema.servers, { settings: sealed })).where(
						E.eq(Schema.servers.id, row.id),
					)
					log.info(`Re-encrypted connection secrets at rest for server ${row.id}`)
				}
			} catch (err) {
				// secrets sealed with a key we no longer have: the same "can't run until an admin fixes it" case as
				// invalid settings, and worth surviving boot for, since every other server may be fine
				broken = true
				brokenReason = err
			}
		}
		let enabled = row.enabled
		if (broken) {
			log.error(brokenReason, `Server ${row.id} has invalid settings, it won't have a live slice until it's repaired`)
			if (enabled) {
				// force it disabled so that repairing the settings later doesn't silently bring it back online -- an admin has to
				// explicitly re-enable it once they're confident the fix is correct
				enabled = false
				await ctx.db({ redactParams: true }).update(Schema.servers).set({ enabled: false }).where(E.eq(Schema.servers.id, row.id))
				log.warn(`Server ${row.id} was enabled but has broken settings; forcing it disabled`)
			}
		}
		serverRegistry.set(row.id, {
			id: row.id,
			displayName: row.displayName,
			enabled,
			defaultServer: row.defaultServer,
			broken,
		})
	}
	settings$.next({ scope: 'registry' })
}

export async function createServerEntry(ctx: C.Db, input: {
	id: SS.ServerId
	displayName: string
	settings: unknown
}) {
	if (serverRegistry.has(input.id)) {
		return { code: 'err:server-already-exists' as const }
	}
	const settingsRes = SETTINGS.ServerSettingsSchema.safeParse(input.settings)
	if (!settingsRes.success) {
		return { code: 'err:invalid-settings' as const, message: settingsRes.error.message }
	}

	const newServer: SS.ServerState = {
		id: input.id,
		displayName: input.displayName,
		enabled: false,
		defaultServer: false,
		layerQueue: [],
		teamswaps: null,
		settings: settingsRes.data,
	}
	await ctx.db({ redactParams: true }).insert(Schema.servers).values(
		superjsonify(Schema.servers, { ...newServer, settings: sealConnections(newServer.settings) }),
	)
	serverRegistry.set(newServer.id, {
		id: newServer.id,
		displayName: newServer.displayName,
		enabled: false,
		defaultServer: false,
		broken: false,
	})
	settings$.next({ scope: 'registry' })
	log.info('Server %s created', newServer.id)
	return { code: 'ok' as const }
}

export async function deleteServerEntry(ctx: C.Db, serverId: SS.ServerId) {
	if (!serverRegistry.has(serverId)) return { code: 'err:server-not-found' as const }
	await ctx.db({ redactParams: true }).delete(Schema.servers).where(E.eq(Schema.servers.id, serverId))
	serverRegistry.delete(serverId)
	settings$.next({ scope: 'registry' })
	log.info('Server %s deleted', serverId)
	return { code: 'ok' as const }
}

export async function setServerEnabled(ctx: C.Db, serverId: SS.ServerId, enabled: boolean) {
	const entry = serverRegistry.get(serverId)
	if (!entry) return { code: 'err:server-not-found' as const }
	if (enabled && entry.broken) return { code: 'err:server-settings-invalid' as const }
	await ctx.db({ redactParams: true }).update(Schema.servers).set({ enabled }).where(E.eq(Schema.servers.id, serverId))
	entry.enabled = enabled
	settings$.next({ scope: 'registry' })
	log.info('Server %s %s', serverId, enabled ? 'enabled' : 'disabled')
	return { code: 'ok' as const }
}

export async function setDefaultServerEntry(ctx: C.Db, serverId: SS.ServerId) {
	if (!serverRegistry.has(serverId)) return { code: 'err:server-not-found' as const }
	await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
		await ctx.db({ redactParams: true }).update(Schema.servers).set({ defaultServer: false })
		await ctx.db({ redactParams: true }).update(Schema.servers).set({ defaultServer: true }).where(E.eq(Schema.servers.id, serverId))
	})
	for (const entry of serverRegistry.values()) {
		entry.defaultServer = entry.id === serverId
	}
	settings$.next({ scope: 'registry' })
	log.info('Server %s set as default', serverId)
	return { code: 'ok' as const }
}

// ============================== per-server settings ==============================

export type SettingsUpdate = Readonly<[SETTINGS.PublicServerSettings, SS.LQStateUpdate['source'] | null]>

export type ServerSettingsSlice = {
	settings: SETTINGS.PublicServerSettings
	update$: Rx.ReplaySubject<SettingsUpdate>
}

export function initServerSettingsSlice(
	ctx: C.ServerSliceCleanup & C.ServerId,
	serverState: SS.ServerState,
): ServerSettingsSlice {
	const slice: ServerSettingsSlice = {
		settings: SETTINGS.getPublicSettings(serverState.settings),
		update$: new Rx.ReplaySubject<SettingsUpdate>(1),
	}
	slice.update$.next([slice.settings, null])

	ctx.cleanup.push(
		slice.update$,
		settings$
			.pipe(Rx.filter((e): e is Extract<SettingsEvent, { scope: 'server' }> => e.scope === 'server' && e.serverId === ctx.serverId))
			.subscribe(({ settings, source }) => {
				const publicSettings = SETTINGS.getPublicSettings(settings)
				if (Obj.deepEqual(publicSettings, slice.settings)) return
				slice.settings = publicSettings
				slice.update$.next([publicSettings, source])
			}),
	)

	return slice
}

// the connection secrets encrypted at rest: the RCON password (local/sftp), the SFTP log password, and the
// server-agent token. In memory these are always plaintext; sealing happens only at a DB write, opening only
// at a DB read.
function transformConnectionSecretValues(
	connections: SETTINGS.ServerConnection,
	fn: (value: string) => string,
): SETTINGS.ServerConnection {
	switch (connections.type) {
		case 'local':
			return { ...connections, rcon: { ...connections.rcon, password: fn(connections.rcon.password) } }
		case 'sftp':
			return {
				...connections,
				rcon: { ...connections.rcon, password: fn(connections.rcon.password) },
				sftp: { ...connections.sftp, password: fn(connections.sftp.password) },
			}
		case 'server-agent':
			return { ...connections, token: fn(connections.token) }
		default:
			assertNever(connections)
	}
}

function transformConnectionSecrets(
	settings: SETTINGS.ServerSettings,
	fn: (value: string) => string,
): SETTINGS.ServerSettings {
	return { ...settings, connections: transformConnectionSecretValues(settings.connections, fn) }
}

export const sealConnections = (settings: SETTINGS.ServerSettings) => transformConnectionSecrets(settings, SecretBox.seal)
export const openConnections = (settings: SETTINGS.ServerSettings) => transformConnectionSecrets(settings, SecretBox.open)
export const resealConnections = (settings: SETTINGS.ServerSettings) => transformConnectionSecrets(settings, SecretBox.reseal)

// whether any of a server's connection secrets is stored in a form the current key and envelope version no
// longer produce, so the backfill knows to rewrite the row
export function connectionsNeedReseal(settings: SETTINGS.ServerSettings): boolean {
	let needed = false
	transformConnectionSecrets(settings, value => {
		needed ||= SecretBox.needsReseal(value)
		return value
	})
	return needed
}
export const sealConnectionValues = (connections: SETTINGS.ServerConnection) => transformConnectionSecretValues(connections, SecretBox.seal)
export const openConnectionValues = (connections: SETTINGS.ServerConnection) => transformConnectionSecretValues(connections, SecretBox.open)

// reads settings for a server that may not have a live slice (e.g. it's disabled), always going to the DB
export async function getServerSettings(ctx: C.Db, serverId: SS.ServerId): Promise<SETTINGS.ServerSettings> {
	const [row] = await ctx.db().select({ id: Schema.servers.id, settings: Schema.servers.settings }).from(Schema.servers).where(
		E.eq(Schema.servers.id, serverId),
	)
	if (!row) throw new Error(`Server ${serverId} not found`)
	return openConnections(SETTINGS.ServerSettingsSchema.parse(unsuperjsonify(Schema.servers, row).settings))
}

// the one place that writes the settings column and broadcasts the change; everything else (mutations, repairs) routes through this
export async function updateServerSettings(
	ctx: C.Db & C.Tx & C.ServerId,
	newSettings: SETTINGS.ServerSettings,
	source: SS.LQStateUpdate['source'],
) {
	await ctx.db({ redactParams: true })
		.update(Schema.servers)
		.set(superjsonify(Schema.servers, { settings: sealConnections(newSettings) }))
		.where(E.eq(Schema.servers.id, ctx.serverId))

	ctx.tx.unlockTasks.push(() => settings$.next({ scope: 'server', serverId: ctx.serverId, settings: newSettings, source }))
}

// reads the raw, unvalidated settings blob so an admin can repair it if it fails schema validation (e.g. after a breaking change)
export async function getRawServerSettings(ctx: C.Db, serverId: SS.ServerId) {
	const [row] = await ctx.db().select({ settings: Schema.servers.settings }).from(Schema.servers).where(E.eq(Schema.servers.id, serverId))
	if (!row) return { code: 'err:server-not-found' as const }
	return { code: 'ok' as const, settings: unsuperjsonify(Schema.servers, row).settings }
}

// settings fields that are baked into a running slice at setup time and never refreshed afterwards. `connections` requires a full
// destroy+init restart to take effect; the admin-list fields only need the adminList resource invalidated (see
// SquadServer.invalidateAdminList) since it now reads them fresh on every fetch.
const ADMIN_LIST_AFFECTING_FIELDS = ['adminListSources', 'adminIdentifyingPermissions'] as const

export async function updateRawServerSettings(
	ctx: C.Db,
	serverId: SS.ServerId,
	rawSettings: unknown,
	user: USR.MiniUser,
	opts: { access: RBAC.SettingsWriteAccess; canWriteSensitive: boolean } = { access: { kind: 'all' }, canWriteSensitive: true },
) {
	const entry = serverRegistry.get(serverId)
	if (!entry) return { code: 'err:server-not-found' as const }
	const wasBroken = entry.broken

	const priorRawRes = await getRawServerSettings(ctx, serverId)
	const priorParseRes = priorRawRes.code === 'ok' ? SETTINGS.ServerSettingsSchema.safeParse(priorRawRes.settings) : undefined
	const priorBroken = !priorParseRes?.success
	// prior connection secrets are stored sealed; open them so every comparison and diff below runs on
	// plaintext (sealing again is deferred to updateServerSettings)
	const priorSettings = priorParseRes?.success ? openConnections(priorParseRes.data) : undefined

	// non-sensitive writers get connections redacted on read, so whatever they send back is ignored: the stored
	// connections are carried over (as plaintext, so the change comparison below sees no spurious diff) before validation
	if (!opts.canWriteSensitive) {
		if (rawSettings && typeof rawSettings === 'object') {
			;(rawSettings as Record<string, unknown>).connections = priorSettings?.connections
		}
	}

	const parseRes = SETTINGS.ServerSettingsSchema.safeParse(rawSettings)
	if (!parseRes.success) {
		return { code: 'err:invalid-settings' as const, message: parseRes.error.message }
	}

	if (opts.access.kind !== 'all') {
		// a path-restricted writer can't repair broken settings: without a valid prior value there's no diff to check
		if (priorBroken) {
			return RBAC.permissionDenied({ check: 'all' as const, permits: [RBAC.perm('server-settings:write', { serverId, paths: null })] })
		}
		const deniedPaths = diffSettings(priorSettings!, parseRes.data)
			.map((c) => c.path)
			// connection changes are governed by write-sensitive, not by path grants
			.filter((p) => !(p === 'connections' || p.startsWith('connections.')))
			.filter((p) => !RBAC.settingsPathAllowed(opts.access, p))
		if (deniedPaths.length > 0) {
			return RBAC.permissionDenied({
				check: 'all' as const,
				permits: [RBAC.perm('server-settings:write', { serverId, paths: deniedPaths })],
			})
		}
	}

	const connectionsChanged = priorBroken || !Obj.deepEqual(priorSettings!.connections, parseRes.data.connections)
	const adminListFieldsChanged = priorBroken || !Obj.deepEqual(
		Obj.selectProps(priorSettings!, ADMIN_LIST_AFFECTING_FIELDS),
		Obj.selectProps(parseRes.data, ADMIN_LIST_AFFECTING_FIELDS),
	)

	await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
		await updateServerSettings({ ...ctx, serverId }, parseRes.data, { type: 'manual', user, event: 'edit-settings' })
	})

	// a repair has no valid prior state to diff against, so every field reads as newly set
	const changes = diffSettings(priorSettings ?? {}, parseRes.data)

	entry.broken = false
	settings$.next({ scope: 'registry' })
	log.info(wasBroken ? 'Server %s settings repaired' : 'Server %s settings updated', serverId)

	if (connectionsChanged) {
		await SquadServer.restartSliceIfRunning(serverId)
	} else {
		await SquadServer.ensureSliceRunning(serverId)
		if (adminListFieldsChanged) SquadServer.invalidateAdminList(serverId)
	}
	return { code: 'ok' as const, changes }
}

// ============================== unified settings bus ==============================

export type SettingsEvent =
	| { scope: 'global'; settings: SETTINGS.GlobalSettings }
	| { scope: 'server'; serverId: SS.ServerId; settings: SETTINGS.ServerSettings; source: SS.LQStateUpdate['source'] }
	// the server registry changed (created/deleted/enabled/disabled/default changed/repaired)
	| { scope: 'registry' }

// the single channel every settings change (global, per-server, or registry) is broadcast on
export const settings$ = new Rx.Subject<SettingsEvent>()

// ============================== public settings (safe for any connected client; no connection details) ==============================

export type PublicSettings = {
	layerQueue: { lowQueueWarningThreshold: number; maxQueueSize: number }
	topBarColor: SETTINGS.GlobalSettings['topBarColor']
	navLinks: SETTINGS.GlobalSettings['navLinks']
	chat: SETTINGS.GlobalSettings['chat']
	commands: SETTINGS.GlobalSettings['commands']
	commandAliases: SETTINGS.GlobalSettings['commandAliases']
	vote: { voteDuration: number; voteDisplayProps: SETTINGS.GlobalSettings['vote']['voteDisplayProps'] }
	servers: ServerEntry[]
	playerGroupings: SETTINGS.GlobalSettings['playerGroupings']
	squadServer: { tickRateThresholds: SETTINGS.GlobalSettings['squadServer']['tickRateThresholds'] }
	adminActionReasons: SETTINGS.GlobalSettings['adminActionReasons']
	requireReasonFor: SETTINGS.GlobalSettings['requireReasonFor']
	messageVariables: SETTINGS.GlobalSettings['messageVariables']
}

function buildPublicSettings(): PublicSettings {
	return {
		layerQueue: Obj.selectProps(GLOBAL_SETTINGS.layerQueue, ['lowQueueWarningThreshold', 'maxQueueSize']),
		topBarColor: GLOBAL_SETTINGS.topBarColor,
		navLinks: GLOBAL_SETTINGS.navLinks,
		chat: GLOBAL_SETTINGS.chat,
		commands: GLOBAL_SETTINGS.commands,
		commandAliases: GLOBAL_SETTINGS.commandAliases,
		vote: {
			voteDuration: GLOBAL_SETTINGS.vote.voteDuration,
			voteDisplayProps: GLOBAL_SETTINGS.vote.voteDisplayProps,
		},
		servers: listServerEntries(),
		playerGroupings: GLOBAL_SETTINGS.playerGroupings,
		squadServer: { tickRateThresholds: GLOBAL_SETTINGS.squadServer.tickRateThresholds },
		adminActionReasons: GLOBAL_SETTINGS.adminActionReasons,
		requireReasonFor: GLOBAL_SETTINGS.requireReasonFor,
		messageVariables: GLOBAL_SETTINGS.messageVariables,
	}
}

// derived straight from settings$: any global or registry change recomputes it, cached for late subscribers
export const publicSettings$: Rx.Observable<PublicSettings> = settings$.pipe(
	Rx.filter((e) => e.scope === 'global' || e.scope === 'registry'),
	Rx.map(() => buildPublicSettings()),
	Rx.shareReplay(1),
)
// keep it hot from module load so the first real subscriber doesn't miss the startup events and gets the replayed value immediately
publicSettings$.subscribe()

// ============================== orpc router, organized into subrouters by access level ==============================

// safe for any connected client: no connection details, no per-server admin-only settings
const publicRouter = {
	watchPublicSettings: orpcBase.meta({ logLevel: 'trace' }).handler(async function*({ signal }) {
		yield* toAsyncGenerator(publicSettings$.pipe(withAbortSignal(signal!)))
	}),
}

// requires global-settings:read (or any global-settings:write grant): full global settings object, for editing
const globalRouter = {
	// streams the encoded (pre-decode) form, e.g. HumanTime fields as '5m' rather than milliseconds, since this is meant for display/editing
	watchSettings: orpcBase.meta({ logLevel: 'trace' }).handler(async function*({ context: _ctx, signal }) {
		const ctx = DB.addPooledDb(_ctx as any)
		const denyRes = await Rbac.tryDenyGlobalSettingsRead(ctx)
		if (denyRes) {
			yield denyRes
			return
		}
		yield* toAsyncGenerator(
			settings$.pipe(
				Rx.filter((e) => e.scope === 'global'),
				Rx.map((e) => e.settings),
				Rx.startWith(GLOBAL_SETTINGS),
				Rx.map((settings) => SETTINGS.GlobalSettingsSchema.encode(settings)),
				withAbortSignal(signal!),
			),
		)
	}),

	updateSettings: orpcBase
		.meta({ type: 'mutation' })
		.input(z.record(z.string(), z.unknown()))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const access = RBAC.globalSettingsWriteAccess(await Rbac.getUserPermissions(ctx))
			if (access.kind === 'none') {
				return RBAC.permissionDenied({ check: 'all' as const, permits: [RBAC.perm('global-settings:write', { paths: null })] })
			}
			const res = await updateGlobalSettings(ctx, input, access)
			if (res.code !== 'ok') return res
			await AppEventsSys.persistAppEvent(
				ctx,
				AppEvents.create<AppEvents.SettingsUpdated>({
					type: 'SETTINGS_UPDATED',
					actor: { type: 'slm-user', userId: ctx.user.discordId },
					serverId: null,
					matchId: null,
					causeId: null,
					changes: auditableSettingChanges(res.changes),
				}),
			)
			return { code: 'ok' as const }
		}),
}

// requires server-settings:write for the given serverId; connections are always excluded
const serverRouter = {
	watchSettings: orpcBase.meta({ logLevel: 'trace' }).input(z.object({ serverId: z.string() })).handler(async function*(
		{ context: _ctx, signal, input },
	) {
		const obs = SquadServer.sliceStream$(_ctx.wsClientId, input.serverId, (ctx) => ctx.serverSettings.update$).pipe(
			withAbortSignal(signal!),
		)

		yield* toAsyncGenerator(obs)
	}),

	// deliberately doesn't resolve a slice: editing settings is how an admin repairs a broken server or prepares a
	// disabled one, and neither has a slice. Everything below only needs the db + the serverId.
	updateSettings: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string(), ops: z.array(SETTINGS.SettingMutationSchema) }))
		.handler(async ({ context: _ctx, input }) => {
			if (!hasServerEntry(input.serverId)) return { code: 'err:server-not-found' as const }
			const ctx = { ..._ctx, serverId: input.serverId }
			const access = RBAC.serverSettingsWriteAccess(await Rbac.getUserPermissions(ctx), input.serverId)
			if (access.kind === 'none') {
				return RBAC.permissionDenied({
					check: 'all' as const,
					permits: [RBAC.perm('server-settings:write', { serverId: input.serverId, paths: null })],
				})
			}
			for (const mut of input.ops) {
				if (mut.path[0] === 'connections') {
					throw new Orpc.ORPCError('FORBIDDEN', { message: 'err:trying-to-edit-connection-settings' })
				}
			}
			const deniedPaths = input.ops
				.map((op) => RBAC.dottedSettingsPath(op.path))
				.filter((p) => !RBAC.settingsPathAllowed(access, p))
			if (deniedPaths.length > 0) {
				return RBAC.permissionDenied({
					check: 'all' as const,
					permits: [RBAC.perm('server-settings:write', { serverId: input.serverId, paths: deniedPaths })],
				})
			}
			// the mutations are applied in place, so the before-state has to be taken first to have anything to diff
			let changes: SettingChange[] = []
			const updateRes = await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
				const state = await SquadServer.getServerState(ctx)
				const prior = Obj.deepClone(state.settings)
				SETTINGS.applySettingMutations(state.settings, input.ops)
				const res = SETTINGS.ServerSettingsSchema.safeParse(state.settings)
				if (!res.success) {
					return { code: 'err:invalid-settings' as const, message: res.error.message }
				}
				changes = diffSettings(prior, res.data)

				await updateServerSettings(ctx, res.data, {
					type: 'manual',
					user: USR.toMiniUser(ctx.user),
					event: 'edit-settings',
				})
			})
			if (!updateRes) {
				await AppEventsSys.persistAppEvent(
					ctx,
					AppEvents.create<AppEvents.SettingsUpdated>({
						type: 'SETTINGS_UPDATED',
						actor: { type: 'slm-user', userId: ctx.user.discordId },
						serverId: input.serverId,
						matchId: null,
						causeId: null,
						changes: auditableSettingChanges(changes),
					}),
				)
			}
			return updateRes
		}),
}

async function recordServerRegistry(
	ctx: C.Db & C.UserId,
	action: AppEvents.ServerRegistryChanged['action'],
	targetServerId: string,
	// a deleted server is already out of the registry by the time this runs, so its name has to be passed in
	targetServerName = serverRegistry.get(targetServerId)?.displayName,
) {
	await AppEventsSys.persistAppEvent(
		ctx,
		AppEvents.create<AppEvents.ServerRegistryChanged>({
			type: 'SERVER_REGISTRY_CHANGED',
			action,
			targetServerId,
			targetServerName,
			actor: { type: 'slm-user', userId: ctx.user.discordId },
			serverId: null,
			matchId: null,
			causeId: null,
		}),
	)
}

// registry management requires admin:manage-servers (admin:delete-servers for deleteServer); the raw per-server
// settings endpoints are gated by the server-settings:* permissions instead
const adminRouter = {
	enableServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-servers'))
			if (denyRes) return denyRes
			const res = await SquadServer.enableServer(input.serverId)
			if (res.code === 'ok') await recordServerRegistry(ctx, 'enabled', input.serverId)
			return res
		}),

	disableServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-servers'))
			if (denyRes) return denyRes
			const res = await SquadServer.disableServer(input.serverId)
			if (res.code === 'ok') await recordServerRegistry(ctx, 'disabled', input.serverId)
			return res
		}),

	createServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({
			id: SS.ServerIdSchema,
			displayName: z.string().min(1).max(256),
			settings: SETTINGS.ServerSettingsSchema,
		}))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-servers'))
			if (denyRes) return denyRes
			// creating a server means supplying its connection details, so it additionally requires a
			// write-sensitive grant covering the new server id
			const perms = await Rbac.getUserPermissions(ctx)
			if (!RBAC.canWriteSensitiveServerSettings(perms, input.id)) {
				return RBAC.permissionDenied({
					check: 'all' as const,
					permits: [RBAC.perm('server-settings:write-sensitive', { serverId: input.id })],
				})
			}
			const res = await createServerEntry(ctx, input)
			if (res.code === 'ok') await recordServerRegistry(ctx, 'created', input.id)
			return res
		}),

	deleteServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:delete-servers'))
			if (denyRes) return denyRes
			const deletedName = serverRegistry.get(input.serverId)?.displayName
			const res = await SquadServer.deleteServer(input.serverId)
			if (res.code === 'ok') await recordServerRegistry(ctx, 'deleted', input.serverId, deletedName)
			return res
		}),

	setDefaultServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-servers'))
			if (denyRes) return denyRes
			const res = await setDefaultServerEntry(ctx, input.serverId)
			if (res.code === 'ok') await recordServerRegistry(ctx, 'set-default', input.serverId)
			return res
		}),

	// requires server-settings:read for the server; the rcon/sftp connection details are redacted unless the
	// caller holds server-settings:write-sensitive
	getRawSettings: orpcBase
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const perms = await Rbac.getUserPermissions(ctx)
			if (!RBAC.canReadServerSettings(perms, input.serverId)) {
				return RBAC.permissionDenied({ check: 'all' as const, permits: [RBAC.perm('server-settings:read', { serverId: input.serverId })] })
			}
			const res = await getRawServerSettings(ctx, input.serverId)
			if (res.code !== 'ok') return res
			const settings = res.settings
			if (!RBAC.canWriteSensitiveServerSettings(perms, input.serverId)) {
				if (settings && typeof settings === 'object') delete (settings as Record<string, unknown>).connections
				return { code: 'ok' as const, settings, sensitiveOmitted: true as const }
			}
			// connections are stored sealed at rest; open them so the editor shows/edits plaintext instead of the envelope.
			// a settings blob that fails schema validation (repair flow) may not have valid connections to open, so leave it as-is
			if (settings && typeof settings === 'object' && 'connections' in settings) {
				const connRes = SETTINGS.ServerConnectionSchema.safeParse((settings as Record<string, unknown>).connections)
				if (connRes.success) {
					;(settings as Record<string, unknown>).connections = openConnectionValues(connRes.data)
				}
			}
			return { code: 'ok' as const, settings, sensitiveOmitted: false as const }
		}),

	updateRawSettings: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string(), settings: z.unknown() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const perms = await Rbac.getUserPermissions(ctx)
			const access = RBAC.serverSettingsWriteAccess(perms, input.serverId)
			const canWriteSensitive = RBAC.canWriteSensitiveServerSettings(perms, input.serverId)
			// write-sensitive is self-sufficient for the connections: a holder can save connection edits even with no
			// general write grant. updateRawServerSettings still denies any non-connection change they can't make.
			if (access.kind === 'none' && !canWriteSensitive) {
				return RBAC.permissionDenied({
					check: 'all' as const,
					permits: [RBAC.perm('server-settings:write', { serverId: input.serverId, paths: null })],
				})
			}
			const res = await updateRawServerSettings(ctx, input.serverId, input.settings, USR.toMiniUser(_ctx.user), {
				access,
				canWriteSensitive,
			})
			if (res.code !== 'ok') return res
			await AppEventsSys.persistAppEvent(
				ctx,
				AppEvents.create<AppEvents.SettingsUpdated>({
					type: 'SETTINGS_UPDATED',
					actor: { type: 'slm-user', userId: ctx.user.discordId },
					serverId: input.serverId,
					matchId: null,
					causeId: null,
					changes: auditableSettingChanges(res.changes),
				}),
			)
			// the diff is for the audit event only: it carries the raw connection values, so it must not be echoed back
			return { code: 'ok' as const }
		}),
}

// single unified settings router, organized into access-tiered subrouters
export const router = {
	public: publicRouter,
	global: globalRouter,
	server: serverRouter,
	admin: adminRouter,
}
