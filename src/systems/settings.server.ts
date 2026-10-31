import * as E from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema.ts'
import * as Color from '@/lib/color'
import * as Obj from '@/lib/object-utils'
import * as Rx from '@/lib/rxjs'
import { z } from '@/lib/zod'
import * as AppEvents from '@/models/app-events.models'
import type * as CS from '@/models/context-shared.models'
import * as LTag from '@/models/layer-tags.models'
import * as RRS from '@/models/repeat-rulesets.models'
import * as SS from '@/models/server-state.models'
import * as SETTINGS from '@/models/settings.models'
import type * as SM from '@/models/squad.models'
import * as USR from '@/models/users.models'
import * as RBAC from '@/rbac.models.ts'
import type * as C from '@/server/context.ts'
import * as DB from '@/server/db.ts'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import { getOrpcBase } from '@/server/orpc-base'
import * as SecretBox from '@/server/secret-box.server'
import * as Sql from '@/server/sql'
import * as AdminList from '@/systems/adminlist.server'
import * as AppEventsSys from '@/systems/app-events.server'
import * as Rbac from '@/systems/rbac.server'
import * as Seed from '@/systems/seed.server'
import * as ServerConsole from '@/systems/server-console.server'
import * as SquadServerLifecycle from '@/systems/squad-server-lifecycle.server'
import * as SquadServer from '@/systems/squad-server.server'

const module = initModule('settings')
const SQL = Sql.forModule(module)
let log!: ReturnType<typeof module.getLogger>
const orpcBase = getOrpcBase(module)

const globalSettingsRows = SQL.def('globalSettingsRows', SQL.params({}), SQL.select().from(Schema.globalSettings), {
	scans: ['globalSettings'],
})
const globalSettingsP = SQL.params({ settings: Schema.globalSettings.settings })
const writeGlobalSettings = SQL.def(
	'writeGlobalSettings',
	globalSettingsP,
	SQL.update(Schema.globalSettings).set({ settings: globalSettingsP.settings }),
	{ scans: ['globalSettings'] },
)
const insertGlobalSettings = SQL.def(
	'insertGlobalSettings',
	globalSettingsP,
	SQL.insert(Schema.globalSettings).values({ settings: globalSettingsP.settings }),
)

const serverRows = SQL.def('serverRows', SQL.params({}), SQL.select().from(Schema.servers), { scans: ['servers'] })
const serverSettingsRows = SQL.def(
	'serverSettingsRows',
	SQL.params({}),
	SQL.select({ id: Schema.servers.id, settings: Schema.servers.settings }).from(Schema.servers),
	{ scans: ['servers'] },
)
const serverIdP = SQL.params({ id: Schema.servers.id })
const serverSettingsById = SQL.def(
	'serverSettingsById',
	serverIdP,
	SQL.select({ id: Schema.servers.id, settings: Schema.servers.settings })
		.from(Schema.servers)
		.where(E.eq(Schema.servers.id, serverIdP.id)),
)
// the foreign keys onto servers cascade into tables with no index on serverId, which a deletion this rare can afford
const deleteServer = SQL.def('deleteServer', serverIdP, SQL.delete(Schema.servers).where(E.eq(Schema.servers.id, serverIdP.id)), {
	scans: ['serverEventIndex', 'playerEventIndex', 'timeouts'],
})
const clearDefaultServer = SQL.def(
	'clearDefaultServer',
	SQL.params({}),
	SQL.update(Schema.servers).set({ defaultServer: SQL.lit(false) }),
	{ scans: ['servers'] },
)
const markDefaultServer = SQL.def(
	'markDefaultServer',
	serverIdP,
	SQL.update(Schema.servers)
		.set({ defaultServer: SQL.lit(true) })
		.where(E.eq(Schema.servers.id, serverIdP.id)),
)

const serverSettingsP = SQL.params({ id: Schema.servers.id, settings: Schema.servers.settings })
const writeServerSettings = SQL.def(
	'writeServerSettings',
	serverSettingsP,
	SQL.update(Schema.servers).set({ settings: serverSettingsP.settings }).where(E.eq(Schema.servers.id, serverSettingsP.id)),
)
const serverEnabledP = SQL.params({ id: Schema.servers.id, enabled: Schema.servers.enabled })
const writeServerEnabled = SQL.def(
	'writeServerEnabled',
	serverEnabledP,
	SQL.update(Schema.servers).set({ enabled: serverEnabledP.enabled }).where(E.eq(Schema.servers.id, serverEnabledP.id)),
)

const newServerP = SQL.params({
	id: Schema.servers.id,
	displayName: Schema.servers.displayName,
	layerQueue: Schema.servers.layerQueue,
	backburner: Schema.servers.backburner,
	switchRequests: Schema.servers.switchRequests,
	visibility: Schema.servers.visibility,
	ownerDiscordId: Schema.servers.ownerDiscordId,
	settings: Schema.servers.settings,
})
// teamswaps is left to its column default, which reads as no saved teamswaps
const insertServer = SQL.def(
	'insertServer',
	newServerP,
	SQL.insert(Schema.servers).values({
		id: newServerP.id,
		displayName: newServerP.displayName,
		enabled: SQL.lit(false),
		defaultServer: SQL.lit(false),
		layerQueue: newServerP.layerQueue,
		backburner: newServerP.backburner,
		switchRequests: newServerP.switchRequests,
		visibility: newServerP.visibility,
		ownerDiscordId: newServerP.ownerDiscordId,
		settings: newServerP.settings,
	}),
)

export function setup(ctx: C.Db) {
	log = module.getLogger()
	loadGlobalSettings(ctx)
	loadServerRegistry(ctx)
}

// ============================== global settings ==============================

export let GLOBAL_SETTINGS!: SETTINGS.GlobalSettings

// the secrets in the global settings document (the integration tokens) are sealed in the column and opened here,
// like a server's connection secrets. An empty token is stored empty: "unset" is not a secret, and sealing it
// would make every boot's reseal check find a plaintext value to rewrite.
const sealValue = (value: string) => (value === '' ? value : SecretBox.seal(value))
const valueNeedsReseal = (value: string) => value !== '' && SecretBox.needsReseal(value)
const sealGlobalSecrets = (encoded: unknown) => SETTINGS.mapSecretSettingValues('', encoded, sealValue)

function globalSecretsNeedReseal(encoded: unknown): boolean {
	let needed = false
	SETTINGS.mapSecretSettingValues('', encoded, (value) => {
		needed ||= valueNeedsReseal(value)
		return value
	})
	return needed
}

// A token sealed with a key this install no longer has reads as unset, and is logged: the row keeps the sealed
// value, so restoring the key brings it back, and nothing here writes the row until something else changes it.
function openGlobalSecrets(encoded: unknown): { settings: unknown; unreadable: string[] } {
	const unreadable: string[] = []
	const settings = SETTINGS.mapSecretSettingValues('', encoded, (value, path) => {
		try {
			return SecretBox.open(value)
		} catch (err) {
			log.error(err, 'The secret at %s cannot be decrypted; treating it as unset', path)
			unreadable.push(path)
			return ''
		}
	})
	return { settings, unreadable }
}

function persistGlobalSettings(ctx: C.Db) {
	DB.run(ctx, writeGlobalSettings({ settings: sealGlobalSecrets(SETTINGS.GlobalSettingsSchema.encode(GLOBAL_SETTINGS)) }))
}

function loadGlobalSettings(ctx: C.Db) {
	const row = DB.get(ctx, globalSettingsRows({}))
	if (!row) {
		// fresh install: schema defaults include the tiered admins/managers/owners RBAC preset (see defaultRbacSettings)
		const defaultsRes = SETTINGS.parseGlobalSettings({ integrations: Env.legacyIntegrationSettings() })
		if (!defaultsRes.success) throw new Error('Default global settings failed schema validation', { cause: defaultsRes.error })
		const defaults = Seed.applyInitialGlobalSettings(defaultsRes.data)
		DB.run(ctx, insertGlobalSettings({ settings: sealGlobalSecrets(SETTINGS.GlobalSettingsSchema.encode(defaults)) }))
		GLOBAL_SETTINGS = defaults
		log.info('Created default global settings row')
	} else {
		let stored: unknown = row.settings
		// the first boot after the integration credentials moved out of the environment: carried over once, into a
		// row that has never held them. After this the environment is reported and ignored (see main.ts).
		let imported = false
		if (stored && typeof stored === 'object' && (stored as Record<string, unknown>).integrations === undefined) {
			const legacy = Env.legacyIntegrationSettings()
			if (legacy) {
				stored = { ...(stored as Record<string, unknown>), integrations: legacy }
				imported = true
			}
		}
		const needsReseal = globalSecretsNeedReseal(stored)
		const opened = openGlobalSecrets(stored)
		// the trim isn't written back: it costs nothing to redo each boot, and leaving the row alone keeps the grants
		// recoverable if the setting they name comes back under a migration
		const trimRes = SETTINGS.trimStaleSettingsGrants(opened.settings)
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
		if (imported) log.info('Carried the integration credentials over from the environment into the settings')
		if ((imported || needsReseal) && opened.unreadable.length === 0) {
			persistGlobalSettings(ctx)
			if (needsReseal) log.info('Re-encrypted integration credentials at rest')
		}
	}
	Rbac.applyRbacSettings(GLOBAL_SETTINGS.rbac)
	settings$.next({ scope: 'global', settings: GLOBAL_SETTINGS })
}

// what the audit log is allowed to remember about a settings change: everything except the values of the rcon/sftp
// credentials. toRow redacts these again on the way to the table; doing it here as well keeps the in-flight event
// (which gets logged and traced) clean too.
function auditableSettingChanges(changes: Obj.LeafChange[]): AppEvents.SettingsUpdated['changes'] {
	return AppEvents.redactSettingChanges(changes, SETTINGS.redactSettingValue)
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
	// mirrored out of this server's settings; null when the settings leave it unset or are broken
	color: string | null
	// mirrored out of this server's settings, so history can resolve a row's zone without a db read; UTC when broken
	timeZone: string
	// there is no real squad server behind a sandbox, so the client hides what only a real one can answer for
	sandbox: boolean
	// mirrored out of this server's settings so the ruleset editors can say which servers share a ruleset, and so a
	// ruleset in use is not deleted from under a server
	repeatRulesetId: RRS.RulesetId | null
	// 'scoped' entries are delivered to and usable by only their owner (ownerDiscordId); see ServerVisibility and the
	// RBAC scoping in rbac.server. 'public' is every other server. ownerDiscordId is null for public entries.
	visibility: SS.ServerVisibility
	ownerDiscordId: bigint | null
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

// The scoped server ids, for the RBAC matcher that keeps wildcard grants off them (see rbac.models). Read here for this
// module's own server-settings checks, and pushed into rbac.server (which cannot import this module) on every registry
// change via pushScopedServersToRbac.
export function scopedServerIds(): ReadonlySet<SS.ServerId> {
	const ids = new Set<SS.ServerId>()
	for (const entry of serverRegistry.values()) if (entry.visibility === 'scoped') ids.add(entry.id)
	return ids
}

function pushScopedServersToRbac() {
	const map = new Map<SS.ServerId, bigint | null>()
	for (const entry of serverRegistry.values()) if (entry.visibility === 'scoped') map.set(entry.id, entry.ownerDiscordId)
	Rbac.applyScopedServers(map)
}

function loadServerRegistry(ctx: C.Db) {
	for (const row of DB.all(ctx, serverRows({}))) {
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
					DB.run(ctx, writeServerSettings({ id: row.id, settings: sealed }))
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
				DB.run(ctx, writeServerEnabled({ id: row.id, enabled: false }))
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
			color: (settingsRes.success && settingsRes.data.color) || null,
			timeZone: settingsRes.success ? settingsRes.data.timeZone : 'UTC',
			sandbox: settingsRes.success && settingsRes.data.connections.type === 'sandbox',
			repeatRulesetId: settingsRes.success ? settingsRes.data.queue.mainPool.repeatRulesetId : null,
			visibility: row.visibility as SS.ServerVisibility,
			ownerDiscordId: row.ownerDiscordId,
		})
	}
	pushScopedServersToRbac()
	settings$.next({ scope: 'registry' })
}

export function createServerEntry(
	ctx: C.Db,
	input: {
		id: SS.ServerId
		displayName: string
		settings: unknown
		// a scoped server is delivered to and usable by only its owner; tutorials create one emulated server per user
		// this way. Omitted = a normal public server.
		visibility?: SS.ServerVisibility
		ownerDiscordId?: bigint | null
		// the saved queue the server boots with. Tutorials seed a scenario's starting queue here rather than
		// dispatching ops after enable: at creation there is no client, no vote and no sync to reproduce.
		layerQueue?: SS.ServerState['layerQueue']
	},
) {
	if (serverRegistry.has(input.id)) {
		return { code: 'err:server-already-exists' as const }
	}
	const settingsRes = SETTINGS.ServerSettingsSchema.safeParse(input.settings)
	if (!settingsRes.success) {
		return { code: 'err:invalid-settings' as const, message: settingsRes.error.message }
	}

	const visibility = input.visibility ?? 'public'
	// a public server that names no ruleset gets one of its own, so its rules can be edited without touching
	// another server's. Scoped servers are tutorials, which name theirs.
	if (visibility === 'public' && settingsRes.data.queue.mainPool.repeatRulesetId === null) {
		const rulesets = GLOBAL_SETTINGS.repeatRulesets
		const own: RRS.Ruleset = {
			id: RRS.ownIdForServer(rulesets, input.id),
			name: RRS.freeName(rulesets, input.displayName),
			ownerServerId: input.id,
			rules: [...RRS.DEFAULT_RULES],
		}
		const writeRes = patchGlobalSettings(ctx, { repeatRulesets: [...rulesets, own] }, { type: 'system' })
		if (writeRes.code !== 'ok') return writeRes
		settingsRes.data.queue.mainPool.repeatRulesetId = own.id
	}
	const repeatRulesetError = unknownRepeatRulesetError(settingsRes.data)
	if (repeatRulesetError) return repeatRulesetError
	const ownerDiscordId = input.ownerDiscordId ?? null
	settingsRes.data.color ??= pickServerColor(ownerDiscordId)
	const newServer: SS.ServerState = {
		id: input.id,
		displayName: input.displayName,
		enabled: false,
		defaultServer: false,
		layerQueue: input.layerQueue ?? [],
		teamswaps: null,
		backburner: [],
		switchRequests: null,
		visibility,
		ownerDiscordId,
		settings: settingsRes.data,
	}
	const stored = SS.toStoredChanges(newServer)
	DB.run(
		ctx,
		insertServer({
			id: stored.id,
			displayName: stored.displayName,
			layerQueue: stored.layerQueue,
			backburner: stored.backburner,
			switchRequests: stored.switchRequests,
			visibility: stored.visibility,
			ownerDiscordId: stored.ownerDiscordId,
			settings: sealConnections(newServer.settings),
		}),
	)
	serverRegistry.set(newServer.id, {
		id: newServer.id,
		displayName: newServer.displayName,
		enabled: false,
		defaultServer: false,
		broken: false,
		adminLists: newServer.settings.adminLists,
		color: newServer.settings.color ?? null,
		timeZone: newServer.settings.timeZone,
		sandbox: newServer.settings.connections.type === 'sandbox',
		repeatRulesetId: newServer.settings.queue.mainPool.repeatRulesetId,
		visibility,
		ownerDiscordId,
	})
	pushScopedServersToRbac()
	settings$.next({ scope: 'registry' })
	log.info('Server %s created', newServer.id)
	return { code: 'ok' as const }
}

// distinct from the servers the new one will be listed beside: every public server, and the owner's own scoped ones
function pickServerColor(ownerDiscordId: bigint | null): string {
	const taken: string[] = []
	for (const entry of serverRegistry.values()) {
		if (entry.color === null) continue
		if (entry.visibility === 'public' || entry.ownerDiscordId === ownerDiscordId) taken.push(entry.color)
	}
	return Color.pickDistinct(taken)
}

export function deleteServerEntry(ctx: C.Db, serverId: SS.ServerId) {
	if (!serverRegistry.has(serverId)) return { code: 'err:server-not-found' as const }
	DB.run(ctx, deleteServer({ id: serverId }))
	serverRegistry.delete(serverId)
	// the server's own ruleset goes with it, unless another server has come to use it, which keeps it ownerless
	const owned = GLOBAL_SETTINGS.repeatRulesets.filter((r) => r.ownerServerId === serverId)
	if (owned.length > 0) {
		const inUse = repeatRulesetIdsInUse(ctx)
		const rulesets = GLOBAL_SETTINGS.repeatRulesets.flatMap((r) => {
			if (r.ownerServerId !== serverId) return [r]
			if (!inUse.has(r.id)) return []
			const { ownerServerId: _ownerServerId, ...rest } = r
			return [rest]
		})
		patchGlobalSettings(ctx, { repeatRulesets: rulesets }, { type: 'system' })
	}
	// the console outlives a stopped server, so deleting the server is what finally drops its tail
	ServerConsole.disposeFor(serverId)
	pushScopedServersToRbac()
	settings$.next({ scope: 'registry' })
	log.info('Server %s deleted', serverId)
	return { code: 'ok' as const }
}

export function setServerEnabled(ctx: C.Db, serverId: SS.ServerId, enabled: boolean) {
	const entry = serverRegistry.get(serverId)
	if (!entry) return { code: 'err:server-not-found' as const }
	if (enabled && entry.broken) return { code: 'err:server-settings-invalid' as const }
	DB.run(ctx, writeServerEnabled({ id: serverId, enabled }))
	entry.enabled = enabled
	settings$.next({ scope: 'registry' })
	log.info('Server %s %s', serverId, enabled ? 'enabled' : 'disabled')
	return { code: 'ok' as const }
}

export function setDefaultServerEntry(ctx: C.Db, serverId: SS.ServerId) {
	if (!serverRegistry.has(serverId)) return { code: 'err:server-not-found' as const }
	DB.transaction(ctx, {}, (ctx) => {
		DB.run(ctx, clearDefaultServer({}))
		DB.run(ctx, markDefaultServer({ id: serverId }))
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
	const repeatRulesetId = settings.queue.mainPool.repeatRulesetId
	const color = settings.color ?? null
	if (
		!adminListsChanged &&
		entry.sandbox === sandbox &&
		entry.repeatRulesetId === repeatRulesetId &&
		entry.color === color &&
		entry.timeZone === settings.timeZone
	) {
		return
	}
	entry.adminLists = settings.adminLists
	entry.sandbox = sandbox
	entry.repeatRulesetId = repeatRulesetId
	entry.color = color
	entry.timeZone = settings.timeZone
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

export const sealConnections = (settings: SETTINGS.ServerSettings) => SETTINGS.transformConnectionSecrets(settings, SecretBox.seal)
export const openConnections = (settings: SETTINGS.ServerSettings) => SETTINGS.transformConnectionSecrets(settings, SecretBox.open)
export const resealConnections = (settings: SETTINGS.ServerSettings) => SETTINGS.transformConnectionSecrets(settings, SecretBox.reseal)

// whether any of a server's connection secrets is stored in a form the current key and envelope version no
// longer produce, so the backfill knows to rewrite the row
export function connectionsNeedReseal(settings: SETTINGS.ServerSettings): boolean {
	let needed = false
	SETTINGS.transformConnectionSecrets(settings, (value) => {
		needed ||= SecretBox.needsReseal(value)
		return value
	})
	return needed
}
export const sealConnectionValues = (connections: SETTINGS.ServerConnection) =>
	SETTINGS.transformConnectionSecretValues(connections, SecretBox.seal)
export const openConnectionValues = (connections: SETTINGS.ServerConnection) =>
	SETTINGS.transformConnectionSecretValues(connections, SecretBox.open)

// The DB read boundary for a full servers row: connection secrets are sealed in the column and opened here, so
// every ServerState the app works with is plaintext. All full-row reads go through this.
export function parseServerStateRow(rawRow: unknown): SS.ServerState {
	const state = SS.ServerStateSchema.parse(rawRow)
	return { ...state, settings: openConnections(state.settings) }
}

// reads settings for a server that may not have a live managed server (e.g. it's disabled), always going to the DB
export function getServerSettings(ctx: C.Db, serverId: SS.ServerId): SETTINGS.ServerSettings {
	const row = DB.get(ctx, serverSettingsById({ id: serverId }))
	if (!row) throw new Error(`Server ${serverId} not found`)
	return openConnections(SETTINGS.ServerSettingsSchema.parse(row.settings))
}

// the pool configuration of every server in the registry, including disabled ones: a server that is off still
// holds a configuration that a filter it names has to survive for. Servers whose stored settings don't parse are
// skipped, since nothing can be read out of them.
export function listServerPoolConfigs(ctx: C.Db): { serverId: SS.ServerId; mainPool: SETTINGS.PoolConfiguration }[] {
	const configs: { serverId: SS.ServerId; mainPool: SETTINGS.PoolConfiguration }[] = []
	for (const row of DB.all(ctx, serverSettingsRows({}))) {
		const res = SETTINGS.ServerSettingsSchema.safeParse(row.settings)
		if (!res.success) continue
		configs.push({ serverId: row.id, mainPool: res.data.queue.mainPool })
	}
	return configs
}

// the one place that writes the settings column and broadcasts the change; everything else (mutations, repairs) routes through this
export function updateServerSettings(
	ctx: C.Db & C.Tx & CS.ServerId,
	newSettings: SETTINGS.ServerSettings,
	source: SS.LQStateUpdate['source'],
) {
	DB.run(ctx, writeServerSettings({ id: ctx.serverId, settings: sealConnections(newSettings) }))

	DB.afterCommit(ctx, () => {
		syncServerEntry(ctx.serverId, newSettings)
		settings$.next({ scope: 'server', serverId: ctx.serverId, settings: newSettings, source })
	})
}

// reads the raw, unvalidated settings blob so an admin can repair it if it fails schema validation (e.g. after a breaking change)
export function getRawServerSettings(ctx: C.Db, serverId: SS.ServerId) {
	const row = DB.get(ctx, serverSettingsById({ id: serverId }))
	if (!row) return { code: 'err:server-not-found' as const }
	return { code: 'ok' as const, settings: row.settings }
}

// global settings fields whose edit makes an already-fetched admin list wrong (its source, or the permissions that mark
// an admin in it), so the lists have to be refetched rather than just re-selected
const ADMIN_LIST_AFFECTING_FIELDS = ['adminLists'] as const

// the rules of the ruleset a server's settings point at
export function repeatRulesFor(settings: SETTINGS.PublicServerSettings): readonly RRS.RepeatRuleConfig[] {
	return RRS.rulesFor(GLOBAL_SETTINGS.repeatRulesets, settings.queue.mainPool.repeatRulesetId)
}

function unknownRepeatRulesetError(settings: SETTINGS.PublicServerSettings) {
	const id = settings.queue.mainPool.repeatRulesetId
	if (id === null || RRS.find(GLOBAL_SETTINGS.repeatRulesets, id)) return undefined
	return { code: 'err:unknown-repeat-ruleset' as const, message: `No repeat ruleset has the id "${id}"` }
}

const repeatRulesetUsers: ((ctx: C.Db) => Iterable<RRS.RulesetId>)[] = []

// for systems this one cannot import without a cycle (rotations), whose rulesets must survive a settings save
export function registerRepeatRulesetUsers(read: (ctx: C.Db) => Iterable<RRS.RulesetId>) {
	repeatRulesetUsers.push(read)
}

// the ids of the rulesets some server or rotation points at
function repeatRulesetIdsInUse(ctx: C.Db): Set<RRS.RulesetId> {
	const ids = new Set<RRS.RulesetId>()
	for (const entry of serverRegistry.values()) {
		if (entry.repeatRulesetId) ids.add(entry.repeatRulesetId)
	}
	for (const read of repeatRulesetUsers) {
		for (const id of read(ctx)) ids.add(id)
	}
	return ids
}

// replaces some top-level fields of the global settings, for writers that hold only those fields: server creation and
// deletion, tutorials, the ruleset editors and inline tag creation
export function patchGlobalSettings(ctx: C.Db, patch: Partial<SETTINGS.GlobalSettings>, actor: AppEvents.Actor) {
	const parseRes = SETTINGS.parseGlobalSettings({ ...GLOBAL_SETTINGS, ...patch })
	if (!parseRes.success) return { code: 'err:invalid-settings' as const, message: parseRes.error.message }
	const changes = Obj.diffLeaves(GLOBAL_SETTINGS, parseRes.data)
	if (changes.length === 0) return { code: 'ok' as const }
	const settings = parseRes.data
	GLOBAL_SETTINGS = settings
	persistGlobalSettings(ctx)
	DB.afterCommit(ctx, () => settings$.next({ scope: 'global', settings }))
	AppEventsSys.persistAppEvent(
		ctx,
		AppEvents.create<AppEvents.SettingsUpdated>({
			type: 'SETTINGS_UPDATED',
			actor,
			serverId: null,
			matchId: null,
			causeId: null,
			changes: auditableSettingChanges(changes),
		}),
	)
	return { code: 'ok' as const }
}

/** Applies mutations to the global settings, validated and recorded as patchGlobalSettings does. */
export function editGlobalSettings(ctx: C.Db, ops: SETTINGS.SettingMutation[], actor: AppEvents.Actor) {
	const next = Obj.deepClone(GLOBAL_SETTINGS)
	SETTINGS.applySettingMutations(next, ops)
	return patchGlobalSettings(ctx, next, actor)
}

/**
 * Applies mutations to a server's settings, validated as the settings page validates them, and records
 * SETTINGS_UPDATED against `actor`. `authorize` checks what the ops change, the diff updateRawSettings checks too,
 * and is null only for a writer the caller already trusts.
 */
export async function editServerSettings<Denied extends object = never>(
	ctx: C.Db & CS.ServerId,
	ops: SETTINGS.SettingMutation[],
	actor: AppEvents.Actor,
	source: SS.LQStateUpdate['source'],
	authorize: ((changes: Obj.LeafChange[]) => Promise<Denied | null>) | null,
) {
	for (;;) {
		const prior = SquadServer.getServerState(ctx).settings
		const next = Obj.deepClone(prior)
		SETTINGS.applySettingMutations(next, ops)
		const denied = await authorize?.(Obj.diffLeaves(prior, next))
		if (denied) return denied
		const parsed = parseServerSettings(next)
		if (parsed.code !== 'ok') return parsed
		const changes = Obj.diffLeaves(prior, parsed.settings)
		const res = DB.transaction(ctx, {}, (ctx) => {
			// a write that landed while authorize was awaited changes what the ops change, so they are authorized again
			if (!Obj.deepEqual(SquadServer.getServerState(ctx).settings, prior)) return { code: 'err:stale' as const }
			updateServerSettings(ctx, parsed.settings, source)
			return { code: 'ok' as const }
		})
		if (res.code === 'err:stale') continue
		recordServerSettingsUpdated(ctx, actor, changes)
		return { code: 'ok' as const }
	}
}

// what a server's settings must pass to be saved, whichever editor wrote them
function parseServerSettings(raw: unknown) {
	const parseRes = SETTINGS.ServerSettingsSchema.safeParse(raw)
	if (!parseRes.success) return { code: 'err:invalid-settings' as const, message: parseRes.error.message }
	const repeatRulesetError = unknownRepeatRulesetError(parseRes.data)
	if (repeatRulesetError) return repeatRulesetError
	return { code: 'ok' as const, settings: parseRes.data }
}

function recordServerSettingsUpdated(ctx: C.Db & CS.ServerId, actor: AppEvents.Actor, changes: Obj.LeafChange[]) {
	if (changes.length === 0) return
	AppEventsSys.persistAppEvent(
		ctx,
		AppEvents.create<AppEvents.SettingsUpdated>({
			type: 'SETTINGS_UPDATED',
			actor,
			serverId: ctx.serverId,
			matchId: null,
			causeId: null,
			changes: auditableSettingChanges(changes),
		}),
	)
}

// refuses a user who may not write every path these changes touch
function denyServerSettingsChanges(ctx: C.Db & USR.Ctx.Id & CS.AbortSignal & CS.ServerId, changes: { path: string }[]) {
	return Rbac.tryDenyPermissionsForUser(
		ctx,
		SETTINGS.Grants.writeServerSettingsPaths(
			ctx.serverId,
			changes.map((c) => c.path),
		),
	)
}

// creates or replaces one ruleset. Ownership is decided by server creation, never by the writer, so `ownerServerId`
// is kept from the ruleset being replaced.
export function saveRepeatRuleset(ctx: C.Db, input: RRS.Ruleset, actor: AppEvents.Actor) {
	const existing = GLOBAL_SETTINGS.repeatRulesets
	const prior = RRS.find(existing, input.id)
	const { ownerServerId: _ownerServerId, ...rest } = input
	const ruleset: RRS.Ruleset = prior?.ownerServerId !== undefined ? { ...rest, ownerServerId: prior.ownerServerId } : rest
	const rulesets = prior ? existing.map((r) => (r.id === input.id ? ruleset : r)) : [...existing, ruleset]
	const res = patchGlobalSettings(ctx, { repeatRulesets: rulesets }, actor)
	if (res.code !== 'ok') return res
	return { code: 'ok' as const, ruleset }
}

export function deleteRepeatRuleset(ctx: C.Db, id: RRS.RulesetId, actor: AppEvents.Actor) {
	if (!RRS.find(GLOBAL_SETTINGS.repeatRulesets, id)) return { code: 'err:not-found' as const }
	if (repeatRulesetIdsInUse(ctx).has(id)) {
		return { code: 'err:repeat-ruleset-in-use' as const, message: `A server or rotation still uses the repeat ruleset "${id}"` }
	}
	const res = patchGlobalSettings(ctx, { repeatRulesets: GLOBAL_SETTINGS.repeatRulesets.filter((r) => r.id !== id) }, actor)
	if (res.code !== 'ok') return res
	return { code: 'ok' as const }
}

// points a server at a ruleset, on behalf of a plugin
export function setServerRepeatRuleset(ctx: C.Db & CS.ServerId, id: RRS.RulesetId, pluginId: string) {
	if (!RRS.find(GLOBAL_SETTINGS.repeatRulesets, id)) {
		return { code: 'err:unknown-repeat-ruleset' as const, message: `No repeat ruleset has the id "${id}"` }
	}
	let changes: Obj.LeafChange[] = []
	DB.transaction(ctx, {}, (ctx) => {
		const state = SquadServer.getServerState(ctx)
		if (state.settings.queue.mainPool.repeatRulesetId === id) return
		const next = Obj.deepClone(state.settings)
		next.queue.mainPool.repeatRulesetId = id
		changes = Obj.diffLeaves(state.settings, next)
		updateServerSettings(ctx, next, { type: 'plugin', event: 'edit-settings', pluginId })
	})
	if (changes.length > 0) {
		AppEventsSys.persistAppEvent(
			ctx,
			AppEvents.create<AppEvents.SettingsUpdated>({
				type: 'SETTINGS_UPDATED',
				actor: { type: 'plugin', pluginId },
				serverId: ctx.serverId,
				matchId: null,
				causeId: null,
				changes: auditableSettingChanges(changes),
			}),
		)
	}
	return { code: 'ok' as const }
}

// the ids among `tags` that name no configured layer tag
export function unknownLayerTags(tags: readonly LTag.TagId[]): LTag.TagId[] {
	const known = new Set(GLOBAL_SETTINGS.layerTags.map((t) => t.id))
	return tags.filter((id) => !known.has(id))
}

function upsertTag(ctx: C.Db & USR.Ctx.Id, key: 'layerTags' | 'rotationTags', input: LTag.Tag) {
	const existing = GLOBAL_SETTINGS[key]
	if (LTag.labelConflict(existing, input.label, input.id)) {
		return { code: 'err:duplicate-label' as const, message: `Another tag is already labeled "${input.label}"` }
	}
	const tags = existing.some((t) => t.id === input.id) ? existing.map((t) => (t.id === input.id ? input : t)) : [...existing, input]
	const res = patchGlobalSettings(ctx, { [key]: tags }, { type: 'slm-user', userId: ctx.user.discordId })
	if (res.code !== 'ok') return res
	return { code: 'ok' as const, tag: input }
}

// the tag labeled `label`, matched without regard to case, created when there is none. For writers that name a tag
// rather than hold its id.
export function ensureTag(ctx: C.Db, key: 'layerTags' | 'rotationTags', label: string, actor: AppEvents.Actor) {
	const parsed = LTag.LabelSchema.safeParse(label)
	if (!parsed.success) return { code: 'err:invalid-label' as const, message: z.prettifyError(parsed.error) }
	const tags = GLOBAL_SETTINGS[key]
	const existing = tags.find((t) => t.label.trim().toLowerCase() === parsed.data.toLowerCase())
	if (existing) return { code: 'ok' as const, tag: existing }
	const tag: LTag.Tag = { id: LTag.createTagId(parsed.data), label: parsed.data, description: '', color: LTag.suggestColor(tags) }
	const res = patchGlobalSettings(ctx, { [key]: [...tags, tag] }, actor)
	if (res.code !== 'ok') return res
	return { code: 'ok' as const, tag }
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

// what a client sees of a server. ownerDiscordId is deliberately dropped: a scoped server only reaches its owner (the
// handler filters), so the owner id would disclose nothing the recipient doesn't know and is never worth broadcasting.
export type PublicServerEntry = Omit<ServerEntry, 'ownerDiscordId'>

export type PublicSettings = {
	navLinks: SETTINGS.GlobalSettings['navLinks']
	chat: SETTINGS.GlobalSettings['chat']
	commands: SETTINGS.GlobalSettings['commands']
	defaultPrefix: SETTINGS.GlobalSettings['defaultPrefix']
	// the plugins section checks a plugin's command overrides against these before saving them
	allowedPrefixes: SETTINGS.GlobalSettings['allowedPrefixes']
	servers: PublicServerEntry[]
	playerGroupings: SETTINGS.GlobalSettings['playerGroupings']
	teamAttribution: SETTINGS.GlobalSettings['teamAttribution']
	playerActivity: SETTINGS.GlobalSettings['playerActivity']
	playerFlagsRequiringNote: SETTINGS.GlobalSettings['playerFlagsRequiringNote']
	// every client rendering the queue needs these to resolve the tag ids stored on layer items
	layerTags: SETTINGS.GlobalSettings['layerTags']
	// the repeat rules a server applies are looked up here by its ruleset id
	repeatRulesets: SETTINGS.GlobalSettings['repeatRulesets']
	// the rotations pages resolve the tag ids on a rotation against these
	rotationTags: SETTINGS.GlobalSettings['rotationTags']
	defaultRotationRepeatRulesetId: SETTINGS.GlobalSettings['defaultRotationRepeatRulesetId']
	tickRateThresholds: SETTINGS.GlobalSettings['tickRateThresholds']
	adminMessageShorthands: SETTINGS.GlobalSettings['adminMessageShorthands']
	// the commands page lists these as the presets the broadcast command accepts. Their text is broadcast to the whole
	// server in the normal course of things, so there's nothing here a player couldn't already see
	requireReasonFor: SETTINGS.GlobalSettings['requireReasonFor']
	messageVariables: SETTINGS.GlobalSettings['messageVariables']
}

function buildPublicSettings(): PublicSettings {
	return {
		navLinks: GLOBAL_SETTINGS.navLinks,
		chat: GLOBAL_SETTINGS.chat,
		commands: GLOBAL_SETTINGS.commands,
		defaultPrefix: GLOBAL_SETTINGS.defaultPrefix,
		allowedPrefixes: GLOBAL_SETTINGS.allowedPrefixes,
		servers: listServerEntries().map(({ ownerDiscordId: _ownerDiscordId, ...entry }) => entry),
		playerGroupings: GLOBAL_SETTINGS.playerGroupings,
		teamAttribution: GLOBAL_SETTINGS.teamAttribution,
		playerActivity: GLOBAL_SETTINGS.playerActivity,
		playerFlagsRequiringNote: GLOBAL_SETTINGS.playerFlagsRequiringNote,
		layerTags: GLOBAL_SETTINGS.layerTags,
		repeatRulesets: GLOBAL_SETTINGS.repeatRulesets,
		rotationTags: GLOBAL_SETTINGS.rotationTags,
		defaultRotationRepeatRulesetId: GLOBAL_SETTINGS.defaultRotationRepeatRulesetId,
		tickRateThresholds: GLOBAL_SETTINGS.tickRateThresholds,
		adminMessageShorthands: GLOBAL_SETTINGS.adminMessageShorthands,
		requireReasonFor: GLOBAL_SETTINGS.requireReasonFor,
		messageVariables: GLOBAL_SETTINGS.messageVariables,
	}
}

// what one session may see: scoped servers are dropped unless the caller owns them. Ownership is read from the live
// registry rather than the payload (which never carries it). Fast-paths the common case of no scoped servers at all.
export function publicSettingsForUser(ps: PublicSettings, discordId: bigint | undefined): PublicSettings {
	if (!ps.servers.some((s) => s.visibility === 'scoped')) return ps
	return {
		...ps,
		servers: ps.servers.filter((s) => s.visibility !== 'scoped' || getServerEntry(s.id)?.ownerDiscordId === discordId),
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

// encoded once per change for every editor watching, rather than once per editor
const maskedGlobalSettings$ = Rx.concat(
	Rx.defer(() => Rx.of(GLOBAL_SETTINGS)),
	settings$.pipe(
		Rx.filter((e) => e.scope === 'global'),
		Rx.map((e) => e.settings),
	),
).pipe(
	Rx.map((settings) => SETTINGS.maskSecretSettingValue('', SETTINGS.GlobalSettingsSchema.encode(settings))),
	Rx.shareReplay({ bufferSize: 1, refCount: true }),
)

// safe for any connected client: no connection details, no per-server admin-only settings
const publicRouter = {
	watchPublicSettings: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ context: ctx }) {
		yield* Rx.Ext.toAsyncGenerator(
			publicSettings$.pipe(
				Rx.map((ps) => publicSettingsForUser(ps, ctx.user.discordId)),
				Rx.Ext.withAbortSignal(ctx.signal),
			),
		)
	}),
}

// the full global settings object, for editing
const globalRouter = {
	// streams the encoded (pre-decode) form, e.g. HumanTime fields as '5m' rather than milliseconds, since this is meant
	// for display/editing. A saved secret goes out as a placeholder: the editor can replace it, never read it.
	watchSettings: orpcBase.meta({ logLevel: 'trace' }).handler(async function* ({ context: ctx }) {
		yield* Rx.Ext.toAsyncGenerator(maskedGlobalSettings$.pipe(Rx.Ext.withAbortSignal(ctx.signal)))
	}),

	updateSettings: orpcBase
		.meta({ type: 'mutation' })
		.input(z.record(z.string(), z.unknown()))
		.handler(async ({ context: ctx, input }) => {
			// a placeholder sent back stands for the stored secret, so an untouched token is no change at all
			const restored = SETTINGS.restoreMaskedSecrets(input, SETTINGS.GlobalSettingsSchema.encode(GLOBAL_SETTINGS))
			const merged = { ...GLOBAL_SETTINGS, ...restored }
			const parseRes = SETTINGS.parseGlobalSettings(merged)
			if (!parseRes.success) {
				return { code: 'err:invalid-settings' as const, message: parseRes.error.message }
			}

			const changes = Obj.diffLeaves(GLOBAL_SETTINGS, parseRes.data)

			const keptRepeatRulesetIds = new Set(parseRes.data.repeatRulesets.map((r) => r.id))
			const removedInUse = [...repeatRulesetIdsInUse(ctx)].filter((id) => !keptRepeatRulesetIds.has(id))
			if (removedInUse.length > 0) {
				return {
					code: 'err:repeat-ruleset-in-use' as const,
					message: `A server or rotation still uses the repeat ruleset(s) ${removedInUse.map((id) => `"${id}"`).join(', ')}`,
				}
			}

			const changePaths = changes.map((c) => [c.path])
			const denyRes = await Rbac.tryDenyPermissionsForUser(ctx, SETTINGS.Grants.writeGlobalSettingsPaths(changePaths))
			if (denyRes) return denyRes
			const escalationRes = await Rbac.tryDenyRoleSettingsEscalation(ctx, GLOBAL_SETTINGS, parseRes.data)
			if (escalationRes) return escalationRes
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

			persistGlobalSettings(ctx)

			Rbac.applyRbacSettings(GLOBAL_SETTINGS.rbac)
			// admin-list field edits flush rbac via AdminList.changed$ once the list refetches; the rbac subtree
			// (roles/assignments/grants) has no other signal, so flush here when it actually changed
			if (changes.some((c) => c.path === 'rbac' || c.path.startsWith('rbac.'))) Rbac.invalidateAll()
			settings$.next({ scope: 'global', settings: GLOBAL_SETTINGS })
			AppEventsSys.persistAppEvent(
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

	// creates or replaces one ruleset, for the ruleset editors beside a server's pool configuration. A separate
	// endpoint for the same reason as upsertLayerTag: those editors do not hold the whole settings object.
	// Deletion is left to the settings page, which can see what uses a ruleset.
	saveRepeatRuleset: orpcBase
		.meta({ type: 'mutation' })
		.input(RRS.RulesetSchema)
		.handler(({ context: ctx, input }) => saveRepeatRuleset(ctx, input, { type: 'slm-user', userId: ctx.user.discordId })),

	// inline tag creation/editing from the queue. A separate endpoint because updateSettings requires the caller to hold
	// the whole settings object, which needs global-settings:read -- a queue editor holding queue:manage-tags may not have it.
	// Deletion is deliberately absent: tags are only removed from the settings page (see LTag.TagsSchema).
	upsertLayerTag: orpcBase
		.meta({ type: 'mutation' })
		.input(LTag.TagSchema)
		.handler(({ context: ctx, input }) => upsertTag(ctx, 'layerTags', input)),

	// the same, for rotation tags created from the rotation editor
	upsertRotationTag: orpcBase
		.meta({ type: 'mutation' })
		.input(LTag.TagSchema)
		.handler(({ context: ctx, input }) => upsertTag(ctx, 'rotationTags', input)),
}

// one server's settings, never including its connections
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
			return await editServerSettings(
				ctx,
				input.ops,
				{ type: 'slm-user', userId: ctx.user.discordId },
				{ type: 'manual', user: USR.toMiniUser(ctx.user), event: 'edit-settings' },
				(changes) => denyServerSettingsChanges(ctx, changes),
			)
		}),
}

function recordServerRegistry(
	ctx: C.Db & USR.Ctx.Id,
	action: AppEvents.ServerRegistryChanged['action'],
	targetServerId: string,
	// a deleted server is already out of the registry by the time this runs, so its name has to be passed in
	targetServerName = serverRegistry.get(targetServerId)?.displayName,
) {
	AppEventsSys.persistAppEvent(
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

// the server registry, and each server's raw settings
const adminRouter = {
	enableServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: ctx, input }) => {
			const res = await SquadServerLifecycle.enableServer(input.serverId)
			if (res.code === 'ok') recordServerRegistry(ctx, 'enabled', input.serverId)
			return res
		}),

	disableServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: ctx, input }) => {
			const res = await SquadServerLifecycle.disableServer(input.serverId)
			if (res.code === 'ok') recordServerRegistry(ctx, 'disabled', input.serverId)
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
			const res = createServerEntry(ctx, input)
			if (res.code === 'ok') recordServerRegistry(ctx, 'created', input.id)
			return res
		}),

	deleteServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: ctx, input }) => {
			const deletedName = serverRegistry.get(input.serverId)?.displayName
			const res = await SquadServerLifecycle.deleteServer(input.serverId)
			if (res.code === 'ok') recordServerRegistry(ctx, 'deleted', input.serverId, deletedName)
			return res
		}),

	setDefaultServer: orpcBase
		.meta({ type: 'mutation' })
		.input(z.object({ serverId: z.string() }))
		.handler(async ({ context: ctx, input }) => {
			const res = setDefaultServerEntry(ctx, input.serverId)
			if (res.code === 'ok') recordServerRegistry(ctx, 'set-default', input.serverId)
			return res
		}),

	// requires server-settings:read for the server; the rcon/sftp connection details are redacted unless the
	// caller holds server-settings:write-sensitive
	getRawSettings: orpcBase.input(z.object({ serverId: z.string() })).handler(async ({ context: ctx, input }) => {
		const perms = await Rbac.getUserPermissions(ctx)
		const res = getRawServerSettings(ctx, input.serverId)
		if (res.code !== 'ok') return res
		const settings = res.settings
		if (!RBAC.canWriteSensitiveServerSettings(perms, input.serverId, scopedServerIds())) {
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

			const priorRawRes = getRawServerSettings(ctx, serverId)
			const priorParseRes = priorRawRes.code === 'ok' ? SETTINGS.ServerSettingsSchema.safeParse(priorRawRes.settings) : undefined
			const priorBroken = !priorParseRes?.success
			// prior connection secrets are stored sealed; open them so every comparison and diff below runs on
			// plaintext (sealing again is deferred to updateServerSettings)
			const priorSettings = priorParseRes?.success ? openConnections(priorParseRes.data) : undefined

			// a broken prior has nothing to diff against, so every top-level key sent counts as written, connections included
			const sentKeys = rawSettings && typeof rawSettings === 'object' ? Object.keys(rawSettings) : []
			const sentChanges = priorSettings
				? Obj.diffLeaves(priorSettings, rawSettings)
				: (sentKeys.length > 0 ? sentKeys : ['']).map((key) => ({ path: key }))
			const denyRes = await denyServerSettingsChanges({ ...ctx, serverId }, sentChanges)
			if (denyRes) return denyRes

			let patchedRawSettings = rawSettings
			// non-sensitive writers get connections redacted on read, so whatever they send back is ignored: the stored
			// connections are carried over (as plaintext, so the change comparison below sees no spurious diff) before validation
			if (rawSettings && typeof rawSettings === 'object' && !('connections' in rawSettings)) {
				patchedRawSettings = { ...rawSettings, connections: priorSettings?.connections }
			}

			const parsed = parseServerSettings(patchedRawSettings)
			if (parsed.code !== 'ok') return parsed

			const connectionsChanged = priorBroken || !Obj.deepEqual(priorSettings!.connections, parsed.settings.connections)

			DB.transaction(ctx, {}, (ctx) => {
				updateServerSettings({ ...ctx, serverId }, parsed.settings, { type: 'manual', user, event: 'edit-settings' })
			})

			// a repair has no valid prior state to diff against, so every field reads as newly set
			const changes = Obj.diffLeaves(priorSettings ?? {}, parsed.settings)

			// the settings-derived fields of the entry are mirrored by updateServerSettings above; `broken` is not one of
			// them, and this is the only path that can clear it
			if (wasBroken) {
				entry.broken = false
				settings$.next({ scope: 'registry' })
			}
			log.info(wasBroken ? 'Server %s settings repaired' : 'Server %s settings updated', serverId)

			if (connectionsChanged) {
				await SquadServerLifecycle.restartIfRunning(serverId)
			} else {
				await SquadServerLifecycle.ensureRunning(serverId)
			}

			recordServerSettingsUpdated({ ...ctx, serverId }, { type: 'slm-user', userId: ctx.user.discordId }, changes)
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
