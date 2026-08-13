import * as E from 'drizzle-orm'
import { z } from 'zod'

import * as Schema from '$root/drizzle/schema.ts'
import { superjsonify, unsuperjsonify } from '@/lib/drizzle'
import * as Obj from '@/lib/object-utils'
import * as Rx from '@/lib/rxjs'
import { diffSettings, type SettingChange } from '@/lib/settings-diff'
import { assertNever } from '@/lib/type-guards'
import * as AppEvents from '@/models/app-events.models'
import type * as CS from '@/models/context-shared'
import * as LTag from '@/models/layer-tags.models'
import * as SS from '@/models/server-state.models'
import * as SETTINGS from '@/models/settings.models'
import type * as SM from '@/models/squad.models'
import * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models.ts'
import type * as C from '@/server/context.ts'
import * as DB from '@/server/db.ts'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as SecretBox from '@/server/secret-box.server'
import * as AdminList from '@/systems/adminlist.server'
import * as AppEventsSys from '@/systems/app-events.server'
import * as Rbac from '@/systems/rbac.server'
import * as Seed from '@/systems/seed.server'
import * as ServerConsole from '@/systems/server-console.server'
import * as SquadServer from '@/systems/squad-server.server'

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
		const defaults = Seed.applyInitialGlobalSettings(defaultsRes.data)
		await ctx
			.db()
			.insert(Schema.globalSettings)
			.values(superjsonify(Schema.globalSettings, { id: 1, settings: SETTINGS.GlobalSettingsSchema.encode(defaults) }))
		GLOBAL_SETTINGS = defaults
		log.info('Created default global settings row')
	} else {
		const raw = unsuperjsonify(Schema.globalSettings, rows[0]) as any
		// the trim isn't written back: it costs nothing to redo each boot, and leaving the row alone keeps the grants
		// recoverable if the setting they name comes back under a migration
		const trimRes = SETTINGS.trimStaleSettingsGrants(raw.settings)
		if (trimRes.dropped.length > 0) {
			log.warn(
				'Ignoring %d settings grant(s) referencing settings that no longer exist: %s',
				trimRes.dropped.length,
				trimRes.dropped.join(', '),
			)
		}
		// seeds any command this installation's settings predate (see SETTINGS.parseGlobalSettings)
		const parseRes = SETTINGS.parseGlobalSettings(trimRes.settings)
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
	// true if the stored settings for this server failed schema validation (e.g. after a breaking change); it won't have a live managed server until repaired
	broken: boolean
	// mirrored out of this server's settings so that "which admin lists speak for this server" can be answered without a
	// db read: it is asked on every roster poll and every in-game permission check
	adminLists: readonly SM.AdminListId[]
	// there is no real squad server behind a sandbox, so the client hides what only a real one can answer for
	sandbox: boolean
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
					await ctx
						.db({ redactParams: true })
						.update(Schema.servers)
						.set(superjsonify(Schema.servers, { settings: sealed }))
						.where(E.eq(Schema.servers.id, row.id))
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
			log.error(brokenReason, `Server ${row.id} has invalid settings, it won't run until it's repaired`)
			// the row says "broken" and nothing else; the console is the one place an admin can be told what is
			// actually wrong with the settings they have to repair
			ServerConsole.recordSlm(row.id, 'error', 'This server will not start until its settings are repaired', brokenReason)
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
			adminLists: settingsRes.success ? settingsRes.data.adminLists : [],
			sandbox: settingsRes.success && settingsRes.data.connections.type === 'sandbox',
		})
	}
	settings$.next({ scope: 'registry' })
}

export async function createServerEntry(
	ctx: C.Db,
	input: {
		id: SS.ServerId
		displayName: string
		settings: unknown
	},
) {
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
		backburner: [],
		switchRequests: null,
		settings: settingsRes.data,
	}
	await ctx
		.db({ redactParams: true })
		.insert(Schema.servers)
		.values(superjsonify(Schema.servers, { ...newServer, settings: sealConnections(newServer.settings) }))
	serverRegistry.set(newServer.id, {
		id: newServer.id,
		displayName: newServer.displayName,
		enabled: false,
		defaultServer: false,
		broken: false,
		adminLists: newServer.settings.adminLists,
		sandbox: newServer.settings.connections.type === 'sandbox',
	})
	settings$.next({ scope: 'registry' })
	log.info('Server %s created', newServer.id)
	return { code: 'ok' as const }
}

export async function deleteServerEntry(ctx: C.Db, serverId: SS.ServerId) {
	if (!serverRegistry.has(serverId)) return { code: 'err:server-not-found' as const }
	await ctx.db({ redactParams: true }).delete(Schema.servers).where(E.eq(Schema.servers.id, serverId))
	serverRegistry.delete(serverId)
	// the console outlives a stopped server, so deleting the server is what finally drops its tail
	ServerConsole.disposeFor(serverId)
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

// refreshes the fields ServerEntry mirrors out of a server's settings. Runs on every settings write, not just at load:
// the mirror is read on paths that never touch the db, so a missed refresh serves the boot value for the rest of the process.
function syncServerEntry(serverId: SS.ServerId, settings: SETTINGS.ServerSettings) {
	const entry = serverRegistry.get(serverId)
	if (!entry) return
	const adminListsChanged = !Obj.deepEqual(entry.adminLists, settings.adminLists)
	const sandbox = settings.connections.type === 'sandbox'
	if (!adminListsChanged && entry.sandbox === sandbox) return
	entry.adminLists = settings.adminLists
	entry.sandbox = sandbox
	// permissions resolved against the lists this server used to name are cached per player
	if (adminListsChanged) Rbac.invalidateAll()
	settings$.next({ scope: 'registry' })
}

// ============================== per-server settings ==============================

export type SettingsUpdate = Readonly<[SETTINGS.PublicServerSettings, SS.LQStateUpdate['source'] | null]>

export function initServerPayload(ctx: C.ManagedServerCleanup & CS.ServerId, serverState: SS.ServerState): SETTINGS.Ctx.Payload {
	const payload: SETTINGS.Ctx.Payload = {
		settings: SETTINGS.getPublicSettings(serverState.settings),
		update$: new Rx.ReplaySubject<SettingsUpdate>(1),
	}
	payload.update$.next([payload.settings, null])

	ctx.cleanup.push(
		payload.update$,
		settings$
			.pipe(Rx.filter((e): e is Extract<SettingsEvent, { scope: 'server' }> => e.scope === 'server' && e.serverId === ctx.serverId))
			.subscribe(({ settings, source }) => {
				const publicSettings = SETTINGS.getPublicSettings(settings)
				if (Obj.deepEqual(publicSettings, payload.settings)) return
				payload.settings = publicSettings
				payload.update$.next([publicSettings, source])
			}),
	)

	return payload
}

// the connection secrets encrypted at rest: the RCON password (local/sftp), the SFTP log password, and the
// server-agent token. In memory these are always plaintext; sealing happens only at a DB write, opening only
// at a DB read.
function transformConnectionSecretValues(connections: SETTINGS.ServerConnection, fn: (value: string) => string): SETTINGS.ServerConnection {
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
		// nothing to seal: the emulator's rcon password is generated per process and never persisted
		case 'sandbox':
			return connections
		default:
			assertNever(connections)
	}
}

function transformConnectionSecrets(settings: SETTINGS.ServerSettings, fn: (value: string) => string): SETTINGS.ServerSettings {
	return { ...settings, connections: transformConnectionSecretValues(settings.connections, fn) }
}

export const sealConnections = (settings: SETTINGS.ServerSettings) => transformConnectionSecrets(settings, SecretBox.seal)
export const openConnections = (settings: SETTINGS.ServerSettings) => transformConnectionSecrets(settings, SecretBox.open)
export const resealConnections = (settings: SETTINGS.ServerSettings) => transformConnectionSecrets(settings, SecretBox.reseal)

// whether any of a server's connection secrets is stored in a form the current key and envelope version no
// longer produce, so the backfill knows to rewrite the row
export function connectionsNeedReseal(settings: SETTINGS.ServerSettings): boolean {
	let needed = false
	transformConnectionSecrets(settings, (value) => {
		needed ||= SecretBox.needsReseal(value)
		return value
	})
	return needed
}
export const sealConnectionValues = (connections: SETTINGS.ServerConnection) => transformConnectionSecretValues(connections, SecretBox.seal)
export const openConnectionValues = (connections: SETTINGS.ServerConnection) => transformConnectionSecretValues(connections, SecretBox.open)

// The DB read boundary for a full servers row: connection secrets are sealed in the column and opened here, so
// every ServerState the app works with is plaintext. All full-row reads go through this.
export function parseServerStateRow(rawRow: unknown): SS.ServerState {
	const state = SS.ServerStateSchema.parse(unsuperjsonify(Schema.servers, rawRow))
	return { ...state, settings: openConnections(state.settings) }
}

// reads settings for a server that may not have a live managed server (e.g. it's disabled), always going to the DB
export async function getServerSettings(ctx: C.Db, serverId: SS.ServerId): Promise<SETTINGS.ServerSettings> {
	const [row] = await ctx
		.db()
		.select({ id: Schema.servers.id, settings: Schema.servers.settings })
		.from(Schema.servers)
		.where(E.eq(Schema.servers.id, serverId))
	if (!row) throw new Error(`Server ${serverId} not found`)
	return openConnections(SETTINGS.ServerSettingsSchema.parse(unsuperjsonify(Schema.servers, row).settings))
}

// the pool configuration of every server in the registry, including disabled ones: a server that is off still
// holds a configuration that a filter it names has to survive for. Servers whose stored settings don't parse are
// skipped, since nothing can be read out of them.
export async function listServerPoolConfigs(ctx: C.Db): Promise<{ serverId: SS.ServerId; mainPool: SETTINGS.PoolConfiguration }[]> {
	const rows = await ctx.db().select({ id: Schema.servers.id, settings: Schema.servers.settings }).from(Schema.servers)
	const configs: { serverId: SS.ServerId; mainPool: SETTINGS.PoolConfiguration }[] = []
	for (const rawRow of rows) {
		const row = unsuperjsonify(Schema.servers, rawRow) as { id: SS.ServerId; settings: unknown }
		const res = SETTINGS.ServerSettingsSchema.safeParse(row.settings)
		if (!res.success) continue
		configs.push({ serverId: row.id, mainPool: res.data.queue.mainPool })
	}
	return configs
}

// the one place that writes the settings column and broadcasts the change; everything else (mutations, repairs) routes through this
export async function updateServerSettings(
	ctx: C.Db & C.Tx & CS.ServerId,
	newSettings: SETTINGS.ServerSettings,
	source: SS.LQStateUpdate['source'],
) {
	await ctx
		.db({ redactParams: true })
		.update(Schema.servers)
		.set(superjsonify(Schema.servers, { settings: sealConnections(newSettings) }))
		.where(E.eq(Schema.servers.id, ctx.serverId))

	ctx.tx.unlockTasks.push(() => {
		syncServerEntry(ctx.serverId, newSettings)
		settings$.next({ scope: 'server', serverId: ctx.serverId, settings: newSettings, source })
	})
}

// reads the raw, unvalidated settings blob so an admin can repair it if it fails schema validation (e.g. after a breaking change)
export async function getRawServerSettings(ctx: C.Db, serverId: SS.ServerId) {
	const [row] = await ctx.db().select({ settings: Schema.servers.settings }).from(Schema.servers).where(E.eq(Schema.servers.id, serverId))
	if (!row) return { code: 'err:server-not-found' as const }
	return { code: 'ok' as const, settings: unsuperjsonify(Schema.servers, row).settings }
}

// global settings fields whose edit makes an already-fetched admin list wrong (its source, or the permissions that mark
// an admin in it), so the lists have to be refetched rather than just re-selected
const ADMIN_LIST_AFFECTING_FIELDS = ['adminLists'] as const

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
	topBarColor: SETTINGS.GlobalSettings['topBarColor']
	navLinks: SETTINGS.GlobalSettings['navLinks']
	chat: SETTINGS.GlobalSettings['chat']
	commands: SETTINGS.GlobalSettings['commands']
	servers: ServerEntry[]
	playerGroupings: SETTINGS.GlobalSettings['playerGroupings']
	teamAttribution: SETTINGS.GlobalSettings['teamAttribution']
	playerFlagsRequiringNote: SETTINGS.GlobalSettings['playerFlagsRequiringNote']
	// every client rendering the queue needs these to resolve the tag ids stored on layer items
	layerTags: SETTINGS.GlobalSettings['layerTags']
	tickRateThresholds: SETTINGS.GlobalSettings['tickRateThresholds']
	adminActionReasons: SETTINGS.GlobalSettings['adminActionReasons']
	// the commands page lists these as the presets the broadcast command accepts. Their text is broadcast to the whole
	// server in the normal course of things, so there's nothing here a player couldn't already see
	requireReasonFor: SETTINGS.GlobalSettings['requireReasonFor']
	messageVariables: SETTINGS.GlobalSettings['messageVariables']
}

function buildPublicSettings(): PublicSettings {
	return {
		topBarColor: GLOBAL_SETTINGS.topBarColor,
		navLinks: GLOBAL_SETTINGS.navLinks,
		chat: GLOBAL_SETTINGS.chat,
		commands: GLOBAL_SETTINGS.commands,
		servers: listServerEntries(),
		playerGroupings: GLOBAL_SETTINGS.playerGroupings,
		teamAttribution: GLOBAL_SETTINGS.teamAttribution,
		playerFlagsRequiringNote: GLOBAL_SETTINGS.playerFlagsRequiringNote,
		layerTags: GLOBAL_SETTINGS.layerTags,
		tickRateThresholds: GLOBAL_SETTINGS.tickRateThresholds,
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
	watchPublicSettings: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ signal }) {
		yield* Rx.Ext.toAsyncGenerator(publicSettings$.pipe(Rx.Ext.withAbortSignal(signal!)))
	}),
}

// requires global-settings:read (or any global-settings:write grant): full global settings object, for editing
const globalRouter = {
	// streams the encoded (pre-decode) form, e.g. HumanTime fields as '5m' rather than milliseconds, since this is meant for display/editing
	watchSettings: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ context: ctx }) {
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, SETTINGS.Grants.globalSettingsRead())
		if (denyRes) {
			yield denyRes
			return
		}
		yield* Rx.Ext.toAsyncGenerator(
			settings$.pipe(
				Rx.filter((e) => e.scope === 'global'),
				Rx.map((e) => e.settings),
				Rx.startWith(GLOBAL_SETTINGS),
				Rx.map((settings) => SETTINGS.GlobalSettingsSchema.encode(settings)),
				Rx.Ext.withAbortSignal(ctx.signal),
			),
		)
	}),

	updateSettings: orpcBase
		.meta({ type: 'mutation' })
		.input(z.record(z.string(), z.unknown()))
		.handler(async ({ context: ctx, input }) => {
			const merged = { ...GLOBAL_SETTINGS, ...input }
			const parseRes = SETTINGS.parseGlobalSettings(merged)
			if (!parseRes.success) {
				return { code: 'err:invalid-settings' as const, message: parseRes.error.message }
			}

			const changes = diffSettings(GLOBAL_SETTINGS, parseRes.data)

			const changePaths = changes.map((c) => [c.path])
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, SETTINGS.Grants.writeGlobalSettingsPaths(changePaths))
			if (denyRes) return denyRes
			GLOBAL_SETTINGS = parseRes.data

			// make sure the admin list is invalidated if any of the admin list-affecting fields are changed
			outer: for (const field of ADMIN_LIST_AFFECTING_FIELDS) {
				for (const change of changes) {
					if (change.path.includes(field)) {
						AdminList.invalidateAll(ctx)
						break outer
					}
				}
			}

			await ctx
				.db({ redactParams: true })
				.update(Schema.globalSettings)
				.set(superjsonify(Schema.globalSettings, { settings: SETTINGS.GlobalSettingsSchema.encode(GLOBAL_SETTINGS) }))

			Rbac.applyRbacSettings(GLOBAL_SETTINGS.rbac)
			// admin-list field edits flush rbac via AdminList.changed$ once the list refetches; the rbac subtree
			// (roles/assignments/grants) has no other signal, so flush here when it actually changed
			if (changes.some((c) => c.path === 'rbac' || c.path.startsWith('rbac.'))) Rbac.invalidateAll()
			settings$.next({ scope: 'global', settings: GLOBAL_SETTINGS })
			await AppEventsSys.persistAppEvent(
				ctx,
				AppEvents.create<AppEvents.SettingsUpdated>({
					type: 'SETTINGS_UPDATED',
					actor: { type: 'slm-user', userId: ctx.user.discordId },
					serverId: null,
					matchId: null,
					causeId: null,
					changes: auditableSettingChanges(changes),
				}),
			)
			return { code: 'ok' as const, changes }
		}),

	// inline tag creation/editing from the queue. A separate endpoint because updateSettings requires the caller to hold
	// the whole settings object, which needs global-settings:read -- a queue editor holding queue:manage-tags may not have it.
	// Deletion is deliberately absent: tags are only removed from the settings page (see LTag.TagsSchema).
	upsertLayerTag: orpcBase
		.meta({ type: 'mutation' })
		.input(LTag.TagSchema)
		.handler(async ({ context: ctx, input }) => {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('queue:manage-tags'))
			if (denyRes) return denyRes

			const existing = GLOBAL_SETTINGS.layerTags
			if (LTag.labelConflict(existing, input.label, input.id)) {
				return { code: 'err:duplicate-label' as const, message: `Another tag is already labeled "${input.label}"` }
			}
			const idx = existing.findIndex((t) => t.id === input.id)
			const layerTags = idx === -1 ? [...existing, input] : existing.map((t) => (t.id === input.id ? input : t))

			const parseRes = SETTINGS.parseGlobalSettings({ ...GLOBAL_SETTINGS, layerTags })
			if (!parseRes.success) {
				return { code: 'err:invalid-settings' as const, message: parseRes.error.message }
			}
			const changes = diffSettings(GLOBAL_SETTINGS, parseRes.data)
			GLOBAL_SETTINGS = parseRes.data

			await ctx
				.db({ redactParams: true })
				.update(Schema.globalSettings)
				.set(superjsonify(Schema.globalSettings, { settings: SETTINGS.GlobalSettingsSchema.encode(GLOBAL_SETTINGS) }))

			settings$.next({ scope: 'global', settings: GLOBAL_SETTINGS })
			await AppEventsSys.persistAppEvent(
				ctx,
				AppEvents.create<AppEvents.SettingsUpdated>({
					type: 'SETTINGS_UPDATED',
					actor: { type: 'slm-user', userId: ctx.user.discordId },
					serverId: null,
					matchId: null,
					causeId: null,
					changes: auditableSettingChanges(changes),
				}),
			)
			return { code: 'ok' as const, tag: input }
		}),
}

// requires server-settings:write for the given serverId; connections are always excluded
const serverRouter = {
	watchSettings: orpcBase
		.meta({ logLevel: 'trace' })
		.input(z.object({ serverId: z.string() }))
		.handler(async function* ({ context: _ctx, signal, input }) {
			const obs = SquadServer.stream$(_ctx.wsClientId, input.serverId, (ctx) => ctx.serverSettings.update$).pipe(
				Rx.Ext.withAbortSignal(signal!),
			)

			yield* Rx.Ext.toAsyncGenerator(obs)
		}),

	// deliberately doesn't resolve a managed server: editing settings is how an admin repairs a broken server or prepares a
	// disabled one, and neither has a managed server. Everything below only needs the db + the serverId.
	updateSettings: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string(), ops: z.array(SETTINGS.SettingMutationSchema) }))
		.handler(async ({ context: _ctx, input }) => {
			if (!hasServerEntry(input.serverId)) return { code: 'err:server-not-found' as const }
			const ctx = { ..._ctx, serverId: input.serverId }
			const paths = input.ops.map((op) => op.path)
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, SETTINGS.Grants.writeServerSettingsPaths(input.serverId, paths))
			if (denyRes) return denyRes

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
	ctx: C.Db & USR.Ctx.Id,
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
		.handler(async ({ context: ctx, input }) => {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-servers'))
			if (denyRes) return denyRes
			const res = await SquadServer.enableServer(input.serverId)
			if (res.code === 'ok') await recordServerRegistry(ctx, 'enabled', input.serverId)
			return res
		}),

	disableServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: ctx, input }) => {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-servers'))
			if (denyRes) return denyRes
			const res = await SquadServer.disableServer(input.serverId)
			if (res.code === 'ok') await recordServerRegistry(ctx, 'disabled', input.serverId)
			return res
		}),

	createServer: orpcBase
		.meta({ type: 'mutation' })
		.input(
			z.object({
				id: SS.ServerIdSchema,
				displayName: z.string().min(1).max(256),
				settings: SETTINGS.ServerSettingsSchema,
			}),
		)
		.handler(async ({ context: ctx, input }) => {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-servers'))
			if (denyRes) return denyRes
			// creating a server means supplying its connection details, so it additionally requires a
			// write-sensitive grant covering the new server id
			const perms = await Rbac.getUserPermissions(ctx)
			if (!RBAC.canWriteSensitiveServerSettings(perms, input.id)) {
				return RBAC.permissionDenied('all', [`server-settings:write-sensitive on ${input.id}`])
			}
			const res = await createServerEntry(ctx, input)
			if (res.code === 'ok') await recordServerRegistry(ctx, 'created', input.id)
			return res
		}),

	deleteServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: ctx, input }) => {
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
		.handler(async ({ context: ctx, input }) => {
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('admin:manage-servers'))
			if (denyRes) return denyRes
			const res = await setDefaultServerEntry(ctx, input.serverId)
			if (res.code === 'ok') await recordServerRegistry(ctx, 'set-default', input.serverId)
			return res
		}),

	// requires server-settings:read for the server; the rcon/sftp connection details are redacted unless the
	// caller holds server-settings:write-sensitive
	getRawSettings: orpcBase.input(z.object({ serverId: z.string() })).handler(async ({ context: ctx, input }) => {
		const perms = await Rbac.getUserPermissions(ctx)
		const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, RBAC.perm('server-settings:read', { serverId: input.serverId }))
		if (denyRes) return denyRes
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
		.handler(async ({ context: ctx, input }) => {
			const user = ctx.user
			const serverId = input.serverId
			const entry = serverRegistry.get(serverId)
			const rawSettings = input.settings
			if (!entry) return { code: 'err:server-not-found' as const }
			const wasBroken = entry.broken

			const priorRawRes = await getRawServerSettings(ctx, serverId)
			const priorParseRes = priorRawRes.code === 'ok' ? SETTINGS.ServerSettingsSchema.safeParse(priorRawRes.settings) : undefined
			const priorBroken = !priorParseRes?.success
			// prior connection secrets are stored sealed; open them so every comparison and diff below runs on
			// plaintext (sealing again is deferred to updateServerSettings)
			const priorSettings = priorParseRes?.success ? openConnections(priorParseRes.data) : undefined

			const changePaths = diffSettings(priorSettings!, rawSettings).map((c) => [c.path])
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, SETTINGS.Grants.writeServerSettingsPaths(serverId, changePaths))
			if (denyRes) return denyRes

			let patchedRawSettings = rawSettings
			// non-sensitive writers get connections redacted on read, so whatever they send back is ignored: the stored
			// connections are carried over (as plaintext, so the change comparison below sees no spurious diff) before validation
			if (rawSettings && typeof rawSettings === 'object' && !('connections' in rawSettings)) {
				patchedRawSettings = { ...rawSettings, connections: priorSettings?.connections }
			}

			const parseRes = SETTINGS.ServerSettingsSchema.safeParse(patchedRawSettings)
			if (!parseRes.success) {
				return { code: 'err:invalid-settings' as const, message: parseRes.error.message }
			}

			const connectionsChanged = priorBroken || !Obj.deepEqual(priorSettings!.connections, parseRes.data.connections)

			await DB.runTransaction(ctx, { redactParams: true }, async (ctx) => {
				await updateServerSettings({ ...ctx, serverId }, parseRes.data, { type: 'manual', user, event: 'edit-settings' })
			})

			// a repair has no valid prior state to diff against, so every field reads as newly set
			const changes = diffSettings(priorSettings ?? {}, parseRes.data)

			// the settings-derived fields of the entry are mirrored by updateServerSettings above; `broken` is not one of
			// them, and this is the only path that can clear it
			if (wasBroken) {
				entry.broken = false
				settings$.next({ scope: 'registry' })
			}
			log.info(wasBroken ? 'Server %s settings repaired' : 'Server %s settings updated', serverId)

			if (connectionsChanged) {
				await SquadServer.restartIfRunning(serverId)
			} else {
				await SquadServer.ensureRunning(serverId)
			}

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
