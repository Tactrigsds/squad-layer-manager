import * as Schema from '$root/drizzle/schema.ts'
import { toAsyncGenerator, withAbortSignal } from '@/lib/async.ts'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import * as Obj from '@/lib/object'
import * as SS from '@/models/server-state.models'
import * as SETTINGS from '@/models/settings.models'
import * as SM from '@/models/squad.models'
import * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models.ts'
import type * as C from '@/server/context.ts'
import * as DB from '@/server/db.ts'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as Rbac from '@/systems/rbac.server'
import * as AppEvents from '@/models/app-events.models'
import * as AppEventsSys from '@/systems/app-events.server'
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
		const defaults = SETTINGS.GlobalSettingsSchema.parse({})
		await ctx.db().insert(Schema.globalSettings).values(
			superjsonify(Schema.globalSettings, { id: 1, settings: SETTINGS.GlobalSettingsSchema.encode(defaults) }),
		)
		GLOBAL_SETTINGS = defaults
		log.info('Created default global settings row')
	} else {
		const raw = unsuperjsonify(Schema.globalSettings, rows[0]) as any
		const parseRes = SETTINGS.GlobalSettingsSchema.safeParse(raw.settings)
		if (!parseRes.success) {
			log.warn(parseRes.error, 'Global settings in DB failed validation, falling back to defaults')
			GLOBAL_SETTINGS = SETTINGS.GlobalSettingsSchema.parse({})
		} else {
			GLOBAL_SETTINGS = parseRes.data
		}
		log.info('Loaded global settings from DB')
	}
	settings$.next({ scope: 'global', settings: GLOBAL_SETTINGS })
}

export async function updateGlobalSettings(ctx: C.Db, input: Record<string, unknown>) {
	const merged = { ...GLOBAL_SETTINGS, ...input }
	const parseRes = SETTINGS.GlobalSettingsSchema.safeParse(merged)
	if (!parseRes.success) {
		return { code: 'err:invalid-settings' as const, message: parseRes.error.message }
	}

	GLOBAL_SETTINGS = parseRes.data
	await ctx.db({ redactParams: true })
		.update(Schema.globalSettings)
		.set(superjsonify(Schema.globalSettings, { settings: SETTINGS.GlobalSettingsSchema.encode(GLOBAL_SETTINGS) }))
	settings$.next({ scope: 'global', settings: GLOBAL_SETTINGS })
	log.info('Global settings updated')
	return { code: 'ok' as const }
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
		const broken = !settingsRes.success
		let enabled = row.enabled
		if (broken) {
			log.error(settingsRes.error, `Server ${row.id} has invalid settings, it won't have a live slice until it's repaired`)
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
	connections: SETTINGS.ServerConnection
	adminListSources: string[]
	adminIdentifyingPermissions: SM.PlayerPerm[]
}) {
	if (serverRegistry.has(input.id)) {
		return { code: 'err:server-already-exists' as const }
	}
	const settingsRes = SETTINGS.ServerSettingsSchema.safeParse({
		connections: input.connections,
		adminListSources: input.adminListSources,
		adminIdentifyingPermissions: input.adminIdentifyingPermissions,
	})
	if (!settingsRes.success) {
		return { code: 'err:invalid-settings' as const, message: settingsRes.error.message }
	}

	const newServer: SS.ServerState = {
		id: input.id,
		displayName: input.displayName,
		enabled: false,
		defaultServer: false,
		layerQueue: [],
		teamswitches: null,
		settings: settingsRes.data,
	}
	await ctx.db({ redactParams: true }).insert(Schema.servers).values(superjsonify(Schema.servers, newServer))
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

// reads settings for a server that may not have a live slice (e.g. it's disabled), always going to the DB
export async function getServerSettings(ctx: C.Db, serverId: SS.ServerId): Promise<SETTINGS.ServerSettings> {
	const [row] = await ctx.db().select({ id: Schema.servers.id, settings: Schema.servers.settings }).from(Schema.servers).where(
		E.eq(Schema.servers.id, serverId),
	)
	if (!row) throw new Error(`Server ${serverId} not found`)
	return SETTINGS.ServerSettingsSchema.parse(unsuperjsonify(Schema.servers, row).settings)
}

// the one place that writes the settings column and broadcasts the change; everything else (mutations, repairs) routes through this
export async function updateServerSettings(
	ctx: C.Db & C.Tx & C.ServerId,
	newSettings: SETTINGS.ServerSettings,
	source: SS.LQStateUpdate['source'],
) {
	await ctx.db({ redactParams: true })
		.update(Schema.servers)
		.set(superjsonify(Schema.servers, { settings: newSettings }))
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

export async function updateRawServerSettings(ctx: C.Db, serverId: SS.ServerId, rawSettings: unknown, user: USR.MiniUser) {
	const entry = serverRegistry.get(serverId)
	if (!entry) return { code: 'err:server-not-found' as const }
	const wasBroken = entry.broken

	const parseRes = SETTINGS.ServerSettingsSchema.safeParse(rawSettings)
	if (!parseRes.success) {
		return { code: 'err:invalid-settings' as const, message: parseRes.error.message }
	}

	const priorRawRes = await getRawServerSettings(ctx, serverId)
	const priorParseRes = priorRawRes.code === 'ok' ? SETTINGS.ServerSettingsSchema.safeParse(priorRawRes.settings) : undefined
	const priorBroken = !priorParseRes?.success
	const connectionsChanged = priorBroken || !Obj.deepEqual(priorParseRes.data.connections, parseRes.data.connections)
	const adminListFieldsChanged = priorBroken || !Obj.deepEqual(
		Obj.selectProps(priorParseRes.data, ADMIN_LIST_AFFECTING_FIELDS),
		Obj.selectProps(parseRes.data, ADMIN_LIST_AFFECTING_FIELDS),
	)

	await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
		await updateServerSettings({ ...ctx, serverId }, parseRes.data, { type: 'manual', user, event: 'edit-settings' })
	})

	entry.broken = false
	settings$.next({ scope: 'registry' })
	log.info(wasBroken ? 'Server %s settings repaired' : 'Server %s settings updated', serverId)

	if (connectionsChanged) {
		await SquadServer.restartSliceIfRunning(serverId)
	} else {
		await SquadServer.ensureSliceRunning(serverId)
		if (adminListFieldsChanged) SquadServer.invalidateAdminList(serverId)
	}
	return { code: 'ok' as const }
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
	playerFlagColorHierarchy: SETTINGS.GlobalSettings['playerFlagColorHierarchy']
	navLinks: SETTINGS.GlobalSettings['navLinks']
	chat: SETTINGS.GlobalSettings['chat']
	commands: SETTINGS.GlobalSettings['commands']
	commandPrefix: string
	vote: { voteDuration: number; voteDisplayProps: SETTINGS.GlobalSettings['vote']['voteDisplayProps'] }
	servers: ServerEntry[]
	playerFlagGroupings: SETTINGS.GlobalSettings['playerFlagGroupings']
}

function buildPublicSettings(): PublicSettings {
	return {
		layerQueue: Obj.selectProps(GLOBAL_SETTINGS.layerQueue, ['lowQueueWarningThreshold', 'maxQueueSize']),
		topBarColor: GLOBAL_SETTINGS.topBarColor,
		playerFlagColorHierarchy: GLOBAL_SETTINGS.playerFlagColorHierarchy,
		navLinks: GLOBAL_SETTINGS.navLinks,
		chat: GLOBAL_SETTINGS.chat,
		commands: GLOBAL_SETTINGS.commands,
		commandPrefix: GLOBAL_SETTINGS.commandPrefix,
		vote: {
			voteDuration: GLOBAL_SETTINGS.vote.voteDuration,
			voteDisplayProps: GLOBAL_SETTINGS.vote.voteDisplayProps,
		},
		servers: listServerEntries(),
		playerFlagGroupings: GLOBAL_SETTINGS.playerFlagGroupings,
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

// requires admin:manage-global-settings: full global settings object, for editing
const globalRouter = {
	// streams the encoded (pre-decode) form, e.g. HumanTime fields as '5m' rather than milliseconds, since this is meant for display/editing
	watchSettings: orpcBase.meta({ logLevel: 'trace' }).handler(async function*({ context: _ctx, signal }) {
		const ctx = DB.addPooledDb(_ctx as any)
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-global-settings'))
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
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-global-settings'))
			if (denyRes) return denyRes
			const res = await updateGlobalSettings(ctx, input)
			if (res.code === 'ok') {
				await AppEventsSys.persistAppEvent(
					ctx,
					AppEvents.create<AppEvents.SettingsUpdated>({
						type: 'SETTINGS_UPDATED',
						actor: { type: 'slm-user', userId: ctx.user.discordId },
						serverId: null,
						matchId: null,
						causeId: null,
					}),
				)
			}
			return res
		}),
}

// requires settings:write (given serverId); connections are always excluded
const serverRouter = {
	watchSettings: orpcBase.meta({ logLevel: 'trace' }).input(z.object({ serverId: z.string() })).handler(async function*(
		{ context: _ctx, signal, input },
	) {
		const obs = SquadServer.sliceCtx$(_ctx.wsClientId, input.serverId).pipe(
			Rx.switchMap((ctx) => ctx ? ctx.serverSettings.update$ : Rx.EMPTY),
			withAbortSignal(signal!),
		)

		yield* toAsyncGenerator(obs)
	}),

	updateSettings: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string(), ops: z.array(SETTINGS.SettingMutationSchema) }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = SquadServer.resolveSliceCtx(_ctx, input.serverId)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('settings:write'))
			if (denyRes) return denyRes
			for (const mut of input.ops) {
				if (mut.path[0] === 'connections') {
					throw new Orpc.ORPCError('FORBIDDEN', { message: 'err:trying-to-edit-connection-settings' })
				}
			}
			const updateRes = await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
				const state = await SquadServer.getServerState(ctx)
				SETTINGS.applySettingMutations(state.settings, input.ops)
				const res = SETTINGS.ServerSettingsSchema.safeParse(state.settings)
				if (!res.success) {
					return { code: 'err:invalid-settings' as const, message: res.error.message }
				}

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
					}),
				)
			}
			return updateRes
		}),
}

// requires admin:manage-servers (or admin:delete-servers for deleteServer): server registry management and raw per-server settings repair
const adminRouter = {
	enableServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-servers'))
			if (denyRes) return denyRes
			return await SquadServer.enableServer(input.serverId)
		}),

	disableServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-servers'))
			if (denyRes) return denyRes
			return await SquadServer.disableServer(input.serverId)
		}),

	createServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({
			id: SS.ServerIdSchema,
			displayName: z.string().min(1).max(256),
			connections: SETTINGS.ServerConnectionSchema,
			adminListSources: z.array(z.string()),
			adminIdentifyingPermissions: z.array(SM.PLAYER_PERM),
		}))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-servers'))
			if (denyRes) return denyRes
			return await createServerEntry(ctx, input)
		}),

	deleteServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:delete-servers'))
			if (denyRes) return denyRes
			return await SquadServer.deleteServer(input.serverId)
		}),

	setDefaultServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-servers'))
			if (denyRes) return denyRes
			return await setDefaultServerEntry(ctx, input.serverId)
		}),

	getRawSettings: orpcBase
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-servers'))
			if (denyRes) return denyRes
			return await getRawServerSettings(ctx, input.serverId)
		}),

	updateRawSettings: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string(), settings: z.unknown() }))
		.handler(async ({ context: _ctx, input }) => {
			const ctx = DB.addPooledDb(_ctx as any)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-servers'))
			if (denyRes) return denyRes
			return await updateRawServerSettings(ctx, input.serverId, input.settings, USR.toMiniUser(_ctx.user))
		}),
}

// single unified settings router, organized into access-tiered subrouters
export const router = {
	public: publicRouter,
	global: globalRouter,
	server: serverRouter,
	admin: adminRouter,
}
