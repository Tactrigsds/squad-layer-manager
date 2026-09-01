import superjson from 'superjson'
import { z } from 'zod'

import type * as SchemaModels from '$root/drizzle/schema.models'
import { createId } from '@/lib/id'
import * as Obj from '@/lib/object-utils'
import { assertNever } from '@/lib/type-guards'
import * as AAR from '@/models/admin-action-reasons.models'
import * as EM from '@/models/event-meta.models'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import type * as MH from '@/models/match-history.models'
import * as SLL from '@/models/shared-layer-list'
import * as SM from '@/models/squad.models'
import * as TSW from '@/models/teamswaps.models'
import * as USR from '@/models/users.models'

// Application events are SLM's audit log: they record actions SLM (or one of its users) takes.
// A server event's `source` can link back to the app event that caused it (see server-events-base ActionSource),
// which lets a messy set of server events (e.g. a warnAll's N PLAYER_WARNED events) be aggregated into one
// digestible entry. App events with a `serverId`/`matchId` also flow into the server activity feed; global
// ones (settings/filters/users) are audit-only.

export type AppEventId = string

// allocated synchronously so a server event can reference it before it's persisted -- see the expectations
// mechanism in pending-events.models.ts (arming happens before the RCON command is issued)
export function createAppEventId(): AppEventId {
	return createId(16)
}

// who initiated the action
export const ActorSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('slm-user'), userId: USR.UserIdSchema }), // web/orpc operator
	z.object({ type: z.literal('ingame-user'), playerId: SM.PlayerIdSchema }), // chat-command sender (eos)
	z.object({ type: z.literal('system') }), // automated: roll, schedule, startup
	z.object({ type: z.literal('plugin'), pluginId: z.string() }), // a plugin acting on its own initiative
])
export type Actor = z.infer<typeof ActorSchema>

// the envelope every app event carries. spread into each event schema so the union stays a discriminatedUnion.
// most of it is reconstructed from typed columns on read (see fromRow); the payload blob is what the schemas guard.
const baseShape = {
	id: z.string(),
	time: z.number(),
	actor: ActorSchema,
	// the server this action targets; null for global actions (settings/filters/users)
	serverId: z.string().nullable(),
	// feed replay/join key; null for global (never enters a server activity feed)
	matchId: z.number().nullable(),
	// provenance: the app event that caused this one. Today the only chain written is QUEUE_UPDATED -> MAP_SET, and
	// nothing reads it back -- no query, join or UI walks it -- so don't lean on it to make an event reachable.
	causeId: z.string().nullable(),
	// the SLM process (otel service.instance.id) that emitted this event; stamped at persist time. null on events
	// created before this was introduced.
	instanceId: z.string().nullable(),
}
export type Base = z.infer<z.ZodObject<typeof baseShape>>

// ---- discriminated payloads, one per action. types are inferred from the schemas so persisted data can be
// validated on read (see fromRow) with the type as the single source of truth. ----

const event = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => z.object({ ...baseShape, type: z.literal(type), ...shape })

// an admin-action reason snapshotted at action time (template + variable values; see AAR.AppliedReason), so
// renaming/deleting the preset or editing message variables later doesn't corrupt history. The delivered text
// is AAR.renderAppliedReason(reason) -- re-renderable, e.g. with a substituted remaining timeout duration.
const AppliedActionReasonSchema = AAR.AppliedReasonSchema
export type AppliedActionReason = AAR.AppliedReason

export const PlayerWarnedSchema = event('PLAYER_WARNED', {
	message: z.string(),
	// the players this warn action targeted (eos ids)
	targets: z.array(SM.PlayerIdSchema),
	// set when the message came from a preset admin-action reason
	reasonLabel: z.string().optional(),
})
export type PlayerWarned = z.infer<typeof PlayerWarnedSchema>

export const SquadDisbandedSchema = event('SQUAD_DISBANDED', {
	teamId: SM.TeamIdSchema,
	// in-game squad id (not the unique/db id)
	squadId: z.number(),
	squadName: z.string(),
	// the players who were in the squad when it was disbanded (eos ids)
	members: z.array(SM.PlayerIdSchema),
	reason: AppliedActionReasonSchema.optional(),
})
export type SquadDisbanded = z.infer<typeof SquadDisbandedSchema>

export const PlayerRemovedFromSquadSchema = event('PLAYER_REMOVED_FROM_SQUAD', {
	targets: z.array(SM.PlayerIdSchema),
	reason: AppliedActionReasonSchema.optional(),
})
export type PlayerRemovedFromSquad = z.infer<typeof PlayerRemovedFromSquadSchema>

export const TeamChangeForcedSchema = event('TEAM_CHANGE_FORCED', { targets: z.array(SM.PlayerIdSchema) })
export type TeamChangeForced = z.infer<typeof TeamChangeForcedSchema>

// an admin killing players via a double forced team-switch. reason is the optional message shown to the players.
export const PlayerKilledSchema = event('PLAYER_KILLED', {
	targets: z.array(SM.PlayerIdSchema),
	reason: z.string().optional(),
	// set when the reason came from a preset admin-action reason
	reasonLabel: z.string().optional(),
})
export type PlayerKilled = z.infer<typeof PlayerKilledSchema>

export const SquadRenamedSchema = event('SQUAD_RENAMED', {
	teamId: SM.TeamIdSchema,
	squadId: z.number(),
	// the squad's name at the time of the action (the rename resets it to the game default)
	squadName: z.string(),
})
export type SquadRenamed = z.infer<typeof SquadRenamedSchema>

// pure-audit actions with no attributable server event
export const CommanderDemotedSchema = event('COMMANDER_DEMOTED', {
	target: SM.PlayerIdSchema,
	reason: AppliedActionReasonSchema.optional(),
})
export type CommanderDemoted = z.infer<typeof CommanderDemotedSchema>

export const FogOfWarToggledSchema = event('FOG_OF_WAR_TOGGLED', { enabled: z.boolean() })
export type FogOfWarToggled = z.infer<typeof FogOfWarToggledSchema>

// freeform broadcast from the gui
export const BroadcastSentSchema = event('BROADCAST_SENT', {
	message: z.string(),
	// set when the message came from a configured broadcast preset
	presetLabel: z.string().optional(),
})
export type BroadcastSent = z.infer<typeof BroadcastSentSchema>

// a plain kick: the players are removed from the server and may rejoin immediately. A kick with an attached
// timeout is PLAYER_TIMED_OUT instead.
export const PlayerKickedSchema = event('PLAYER_KICKED', {
	targets: z.array(SM.PlayerIdSchema),
	reason: AppliedActionReasonSchema.optional(),
})
export type PlayerKicked = z.infer<typeof PlayerKickedSchema>

// a kick with an attached timeout: the player is re-kicked on join from any SLM server until expiresAt.
// enforcement kicks attribute their PLAYER_KICKED server events to this event (no per-enforcement app event).
export const PlayerTimedOutSchema = event('PLAYER_TIMED_OUT', {
	target: SM.PlayerIdSchema,
	timeoutId: z.string(),
	durationMs: z.number(),
	expiresAt: z.number(),
	// snapshot of the applied reason; custom reasons have no label
	reason: AppliedActionReasonSchema.optional(),
})
export type PlayerTimedOut = z.infer<typeof PlayerTimedOutSchema>

export const TimeoutCancelledSchema = event('TIMEOUT_CANCELLED', {
	target: SM.PlayerIdSchema,
	timeoutId: z.string(),
})
export type TimeoutCancelled = z.infer<typeof TimeoutCancelledSchema>

export const MatchEndedSchema = event('MATCH_ENDED', {})
export type MatchEnded = z.infer<typeof MatchEndedSchema>

export const VoteStartedSchema = event('VOTE_STARTED', {
	choiceCount: z.number(),
	// the layers players could vote for, and how long they had. snapshotted because the queue item this vote
	// belongs to is edited in place as the vote resolves.
	choices: z.array(L.LayerIdSchema).optional(),
	durationMs: z.number().optional(),
})
export type VoteStarted = z.infer<typeof VoteStartedSchema>

export const VoteEndedSchema = event('VOTE_ENDED', {
	reason: z.enum(['vote-timeout', 'ended-early']),
	winnerLayerId: L.LayerIdSchema.nullable(),
	// the final count per choice, in the order the choices were offered. stored by layer (not by queue item id, which
	// means nothing once the item is gone) so the result is readable on its own.
	tally: z.array(z.object({ layerId: L.LayerIdSchema, votes: z.number() })).optional(),
	totalVotes: z.number().optional(),
	// share of the players on the server who voted
	turnoutPercentage: z.number().optional(),
})
export type VoteEnded = z.infer<typeof VoteEndedSchema>

// A layer artifact update taught the engine layers it did not previously recognise, and the matches recorded
// against them were re-resolved. Recorded because it changes what a layer-filtered search over history returns.
export const MatchLayersReconciledSchema = event('MATCH_LAYERS_RECONCILED', {
	// the artifact whose arrival triggered the pass
	layerDataHash: z.string(),
	matchesUpdated: z.number(),
	// the ids that became resolvable, with what they resolved to. RAW: ids are rewritten to the resolved id;
	// an id that was already canonical only gains its parts.
	resolved: z.array(z.object({ from: z.string(), to: z.string(), matches: z.number() })),
	// how many matches still have no resolvable layer after the pass
	unresolvedRemaining: z.number(),
})
export type MatchLayersReconciled = z.infer<typeof MatchLayersReconciledSchema>

// a saved history query's retention rule was switched on or off. Logged because a rule changes what the
// prune pass keeps, which outlives every other setting on the page.
export const HistoryRetentionChangedSchema = event('HISTORY_RETENTION_CHANGED', {
	savedQueryId: z.string(),
	savedQueryName: z.string(),
	retain: z.boolean(),
})
export type HistoryRetentionChanged = z.infer<typeof HistoryRetentionChangedSchema>

export const VoteAbortedSchema = event('VOTE_ABORTED', {})
export type VoteAborted = z.infer<typeof VoteAbortedSchema>

// SLM process lifecycle. APP_STARTED fires on every boot (system actor); APP_RESTARTED is the intentional
// restart-slm admin action recorded before shutdown (slm-user actor).
// the SLM build that was running. absent on events recorded before this was introduced.
const versionShape = { version: z.string().optional() }

export const AppStartedSchema = event('APP_STARTED', versionShape)
export type AppStarted = z.infer<typeof AppStartedSchema>

export const AppRestartedSchema = event('APP_RESTARTED', versionShape)
export type AppRestarted = z.infer<typeof AppRestartedSchema>

// a periodic database backup (see backups.server.ts). audit-only: it records the snapshot that was taken, whether it
// made it to the configured offsite target, and what the event-history prune that ran alongside it deleted -- the one
// place in the app that destroys history, so it needs to be accounted for.
export const BackupCreatedSchema = event('BACKUP_CREATED', {
	fileName: z.string(),
	sizeBytes: z.number(),
	// why the snapshot was taken. Defaulted rather than required: every row written before pre-migration backups
	// existed is a periodic one, so old rows read back correctly instead of being dropped by fromRow.
	reason: z.enum(['periodic', 'pre-migration']).default('periodic'),
	// absent for a pre-migration backup: it is taken before the app (and this event system) is up, so nobody timed it
	durationMs: z.number().optional(),
	// absent when no sftp target is configured; false when the upload failed (the local backup still exists)
	uploaded: z.boolean().optional(),
	// the prune that ran before the snapshot was taken. absent when event-history retention is disabled.
	pruned: z.object({ events: z.number(), matches: z.number() }).optional(),
})
export type BackupCreated = z.infer<typeof BackupCreatedSchema>

// a settings value as it appeared in the audit log. Credentials (the rcon/sftp `connections` block) are recorded as
// having changed but their values are replaced with a marker, so the log never becomes a place to read secrets from.
// This matters beyond tidiness: the audit log is readable with global-settings:read, while the connection details
// themselves need server-settings:write-sensitive for the specific server.
export const REDACTED_SETTING = '[redacted]'
export const SettingChangeSchema = z.object({ path: z.string(), from: z.unknown(), to: z.unknown() })

// the settings subtree holding credentials. `connections` is the whole of it: rcon password, sftp host/user/password,
// and the server-agent token all live under it, and it's the same subtree RBAC gates behind write-sensitive.
function isSensitiveSettingPath(path: string) {
	return path === 'connections' || path.startsWith('connections.')
}

// applied by toRow on the way to the database, so a caller that forgets to redact still can't persist a credential
export function redactSettingChanges(changes: SettingsUpdated['changes']): SettingsUpdated['changes'] {
	return changes?.map((c) => (isSensitiveSettingPath(c.path) ? { ...c, from: REDACTED_SETTING, to: REDACTED_SETTING } : c))
}

// a global (or per-server) settings change. global when serverId is null, per-server otherwise. audit-only.
export const SettingsUpdatedSchema = event('SETTINGS_UPDATED', {
	// the leaf paths this save actually changed, with their before/after values
	changes: z.array(SettingChangeSchema).optional(),
})
export type SettingsUpdated = z.infer<typeof SettingsUpdatedSchema>

// server registry admin action. targetServerId (not serverId) so the servers FK cascade can't delete a
// SERVER_REGISTRY_CHANGED(deleted) event along with the server it records.
export const ServerRegistryChangedSchema = event('SERVER_REGISTRY_CHANGED', {
	action: z.enum(['enabled', 'disabled', 'created', 'deleted', 'set-default']),
	targetServerId: z.string(),
	// the server's display name at the time of the action, so a deleted server is still identifiable
	targetServerName: z.string().optional(),
})
export type ServerRegistryChanged = z.infer<typeof ServerRegistryChangedSchema>

export const FilterChangedSchema = event('FILTER_CHANGED', {
	action: z.enum(['created', 'updated', 'deleted']),
	filterId: z.string(),
	// the filter's name at the time of the action: ids are opaque, and the filter may since have been renamed or deleted
	filterName: z.string().optional(),
	// for 'updated': which fields the edit actually touched (name, description, filter, ...)
	changedFields: z.array(z.string()).optional(),
})
export type FilterChanged = z.infer<typeof FilterChangedSchema>

export const FilterContributorChangedSchema = event('FILTER_CONTRIBUTOR_CHANGED', {
	action: z.enum(['added', 'removed']),
	filterId: z.string(),
	filterName: z.string().optional(),
	// who gained or lost contributor access: an individual user, or everyone holding a role
	contributor: z
		.discriminatedUnion('type', [
			z.object({ type: z.literal('user'), userId: USR.UserIdSchema }),
			z.object({ type: z.literal('role'), roleId: z.string() }),
		])
		.optional(),
})
export type FilterContributorChanged = z.infer<typeof FilterContributorChangedSchema>

// a user acting on their own account
export const UserAccountChangedSchema = event('USER_ACCOUNT_CHANGED', {
	action: z.enum(['steam-linked', 'steam-unlinked', 'nickname-updated']),
	// for steam-linked / steam-unlinked: the accounts this action linked or unlinked (as strings; a steam64 id
	// doesn't survive a trip through JSON as a number)
	steamIds: z.array(z.string()).optional(),
	// whose account was changed, when that is not the actor: an admin linking a steam account on somebody else's
	// behalf. Absent means the actor changed their own. A discord id, as a string, for the same reason as above.
	subjectDiscordId: z.string().optional(),
	// for nickname-updated: null means the nickname was cleared, falling back to the discord username
	prevNickname: z.string().nullable().optional(),
	nickname: z.string().nullable().optional(),
})
export type UserAccountChanged = z.infer<typeof UserAccountChangedSchema>

export const PlayerFlagsUpdatedSchema = event('PLAYER_FLAGS_UPDATED', {
	playerId: SM.PlayerIdSchema,
	// the flags added and removed by this action (id + name resolved from the org's flag list), each with the reason
	// given for that flag alone, as posted to its BM note. `reason` is absent on events recorded before reasons
	// existed, and on flags nothing required one for.
	added: z.array(z.object({ id: z.string(), name: z.string(), reason: z.string().optional() })),
	removed: z.array(z.object({ id: z.string(), name: z.string(), reason: z.string().optional() })),
})
export type PlayerFlagsUpdated = z.infer<typeof PlayerFlagsUpdatedSchema>

export const QueueUpdatedSchema = event('QUEUE_UPDATED', {
	// what drove the queue change:
	//  - 'user-edit': an SLM user (or an internal SLM op like a vote result) changed the queue
	//  - 'roll': the map rolled and the queue advanced
	//  - 'external-layer-change': SLM reconciled its queue to a layer set outside SLM (in-game admin / other RCON)
	trigger: z.enum(['user-edit', 'roll', 'external-layer-change']),
	// all shared-layer-list operations since the last save (the opId span carried by request-list-save)
	ops: z.array(SLL.OperationSchema),
	// the saved queue before and after this save -- diffed to show the net change
	prevList: LL.ListSchema,
	list: LL.ListSchema,
	// how a 'user-edit' save was performed. `force` is the queue panel's force-save toggle (save while others are
	// still editing); `overrodeEditors` are the users who were mid-edit when it landed. absent for roll/external
	// saves, and on events recorded before this was introduced.
	save: z
		.object({
			force: z.boolean(),
			overrodeEditors: z.array(USR.UserIdSchema),
		})
		.optional(),
})
export type QueueUpdated = z.infer<typeof QueueUpdatedSchema>

// the queued (saved) teamswaps changed. like QUEUE_UPDATED, the before/after collections are carried and diffed
// rather than the ops, so churn that cancelled out before the save produces no change at all. the source on each
// swap attributes it to whoever queued that player, which is not necessarily whoever saved.
export const TeamswapsUpdatedSchema = event('TEAMSWAPS_UPDATED', {
	trigger: TSW.SaveTriggerSchema,
	prevSwaps: TSW.TeamswapCollectionSchema,
	swaps: TSW.TeamswapCollectionSchema,
})
export type TeamswapsUpdated = z.infer<typeof TeamswapsUpdatedSchema>

// switch requests fulfilled: the targets asked to change teams (/switch) and were force-switched, by the queue
// draining (system actor), an immediate /switch (ingame-user), or the window's "switch now" (slm-user)
export const SwitchRequestsFulfilledSchema = event('SWITCH_REQUESTS_FULFILLED', {
	targets: z.array(SM.PlayerIdSchema),
	// a just-connected player moved to the other team to make room, when the fulfillment used one
	movedConnector: SM.PlayerIdSchema.optional(),
})
export type SwitchRequestsFulfilled = z.infer<typeof SwitchRequestsFulfilledSchema>

// a layer template was pushed onto the backburner (/reqlayer or the layer-requests panel)
export const LayerRequestAddedSchema = event('LAYER_REQUEST_ADDED', {
	itemId: z.string(),
	description: z.string(),
})
export type LayerRequestAdded = z.infer<typeof LayerRequestAddedSchema>

// backburner templates were removed without being satisfied (explicit removal, or eviction by the owner's newest request)
export const LayerRequestRemovedSchema = event('LAYER_REQUEST_REMOVED', {
	itemIds: z.array(z.string()).min(1),
	descriptions: z.array(z.string()),
})
export type LayerRequestRemoved = z.infer<typeof LayerRequestRemovedSchema>

// generation satisfied these backburner templates: the generated layer matches all of them
export const LayerRequestConsumedSchema = event('LAYER_REQUEST_CONSUMED', {
	itemIds: z.array(z.string()).min(1),
	descriptions: z.array(z.string()),
	layerId: L.LayerIdSchema,
})
export type LayerRequestConsumed = z.infer<typeof LayerRequestConsumedSchema>

// SLM set the next layer on the server. reason 'queue-updated' folds into its cause (the QUEUE_UPDATED linked via
// causeId) and is audit-only; reason 'override' is when SLM set the layer back over an external set, and gets a feed
// entry naming who it overrode.
export const MapSetSchema = event('MAP_SET', {
	layerId: L.LayerIdSchema,
	reason: z.enum(['queue-updated', 'override']),
	// for reason 'override': the external actor whose set SLM overrode. 'unknown' is a layer SLM found already set
	// rather than watched anyone set (the usual case on startup), where naming an actor would invent one.
	overrode: z
		.discriminatedUnion('type', [
			z.object({ type: z.literal('player'), playerId: SM.PlayerIdSchema }),
			z.object({ type: z.literal('rcon') }),
			z.object({ type: z.literal('unknown') }),
		])
		.optional(),
})
export type MapSet = z.infer<typeof MapSetSchema>

// something a plugin wants on the record. `name` scopes within the plugin; the payload is the plugin's
// own shape, carried opaquely (a plugin's schema is not ours to validate on read).
export const PluginEventSchema = event('PLUGIN_EVENT', {
	pluginId: z.string(),
	name: z.string(),
	payload: z.unknown(),
	// one line for the feed/audit log; plugins render their own richer UI elsewhere
	message: z.string(),
})
export type PluginEvent = z.infer<typeof PluginEventSchema>

// an uninstalled plugin's leftovers, removed on request. Names the tables, since once they are dropped
// nothing else records that they existed.
export const PluginDataPurgedSchema = event('PLUGIN_DATA_PURGED', {
	pluginId: z.string(),
	tables: z.array(z.string()),
})
export type PluginDataPurged = z.infer<typeof PluginDataPurgedSchema>

export const AppEventSchema = z.discriminatedUnion('type', [
	PlayerWarnedSchema,
	SquadDisbandedSchema,
	PlayerRemovedFromSquadSchema,
	TeamChangeForcedSchema,
	PlayerKilledSchema,
	SquadRenamedSchema,
	CommanderDemotedSchema,
	FogOfWarToggledSchema,
	BroadcastSentSchema,
	PlayerKickedSchema,
	PlayerTimedOutSchema,
	TimeoutCancelledSchema,
	MatchEndedSchema,
	VoteStartedSchema,
	VoteEndedSchema,
	VoteAbortedSchema,
	MatchLayersReconciledSchema,
	HistoryRetentionChangedSchema,
	QueueUpdatedSchema,
	TeamswapsUpdatedSchema,
	SwitchRequestsFulfilledSchema,
	LayerRequestAddedSchema,
	LayerRequestRemovedSchema,
	LayerRequestConsumedSchema,
	SettingsUpdatedSchema,
	ServerRegistryChangedSchema,
	FilterChangedSchema,
	FilterContributorChangedSchema,
	UserAccountChangedSchema,
	PlayerFlagsUpdatedSchema,
	AppStartedSchema,
	AppRestartedSchema,
	BackupCreatedSchema,
	MapSetSchema,
	PluginEventSchema,
	PluginDataPurgedSchema,
])
export type AppEvent = z.infer<typeof AppEventSchema>

// Whether this event belongs in the live activity feed, as opposed to being audit-log-only. The audit log records
// what SLM did; the feed only wants what's worth reading, and a queue-driven MAP_SET says nothing its QUEUE_UPDATED
// hasn't already said.
//
// Both sides of the feed have to agree on this: emitAppEvent vs persistAppEvent applies it when the event happens,
// and the backfill that rebuilds the buffer from the db applies it again -- an unfiltered backfill puts audit-only
// events into the feed on the next restart, which is not a state the live path can ever produce.
export function isFeedVisible(event: AppEvent): boolean {
	// 'queue-updated' folds into the QUEUE_UPDATED it links to via causeId; 'override' is news (SLM put the layer
	// back over someone else's set) and names who it overrode
	if (event.type === 'MAP_SET') return event.reason === 'override'
	return true
}

export type AppEventType = AppEvent['type']

// What each app event is about, in the same extractor form the server events use (see event-meta.models.ts).
// Players here are the event's subjects -- targets, a disbanded squad's members -- never its actor, which is a
// column of its own.
export const APP_EVENT_META = {
	PLAYER_WARNED: EM.meta<PlayerWarned>({ players: [{ assocType: 'player', get: (e) => e.targets }] }),
	PLAYER_REMOVED_FROM_SQUAD: EM.meta<PlayerRemovedFromSquad>({ players: [{ assocType: 'player', get: (e) => e.targets }] }),
	TEAM_CHANGE_FORCED: EM.meta<TeamChangeForced>({ players: [{ assocType: 'player', get: (e) => e.targets }] }),
	PLAYER_KILLED: EM.meta<PlayerKilled>({ players: [{ assocType: 'player', get: (e) => e.targets }] }),
	PLAYER_KICKED: EM.meta<PlayerKicked>({ players: [{ assocType: 'player', get: (e) => e.targets }] }),
	SQUAD_DISBANDED: EM.meta<SquadDisbanded>({ players: [{ assocType: 'player', get: (e) => e.members }] }),
	COMMANDER_DEMOTED: EM.meta<CommanderDemoted>({ players: [{ assocType: 'player', get: (e) => e.target }] }),
	PLAYER_TIMED_OUT: EM.meta<PlayerTimedOut>({ players: [{ assocType: 'player', get: (e) => e.target }] }),
	TIMEOUT_CANCELLED: EM.meta<TimeoutCancelled>({ players: [{ assocType: 'player', get: (e) => e.target }] }),
	PLAYER_FLAGS_UPDATED: EM.meta<PlayerFlagsUpdated>({ players: [{ assocType: 'player', get: (e) => e.playerId }] }),
	TEAMSWAPS_UPDATED: EM.meta<TeamswapsUpdated>({
		players: [{ assocType: 'player', get: (e) => summarizeTeamswapChanges(e).map((c) => c.playerId) }],
	}),
	SWITCH_REQUESTS_FULFILLED: EM.meta<SwitchRequestsFulfilled>({
		players: [{ assocType: 'player', get: (e) => [...e.targets, e.movedConnector] }],
	}),
	MAP_SET: EM.meta<MapSet>({
		players: [{ assocType: 'player', get: (e) => (e.overrode?.type === 'player' ? e.overrode.playerId : undefined) }],
		layers: [{ kind: 'set', get: (e) => e.layerId }],
	}),
	VOTE_STARTED: EM.meta<VoteStarted>({ layers: [{ kind: 'offered', get: (e) => e.choices }] }),
	VOTE_ENDED: EM.meta<VoteEnded>({
		layers: [
			{ kind: 'set', get: (e) => e.winnerLayerId },
			{ kind: 'offered', get: (e) => e.tally?.map((t) => t.layerId) },
		],
	}),
	LAYER_REQUEST_CONSUMED: EM.meta<LayerRequestConsumed>({ layers: [{ kind: 'queued', get: (e) => e.layerId }] }),
	// the net change, not the whole list: re-indexing every queued layer on every save would make "when was
	// Gorodok queued" answer with every save it sat through
	QUEUE_UPDATED: EM.meta<QueueUpdated>({
		layers: [{ kind: 'queued', get: (e) => summarizeQueueChanges(e).flatMap((c) => c.layerIds) }],
	}),
	SQUAD_RENAMED: EM.meta<SquadRenamed>(),
	FOG_OF_WAR_TOGGLED: EM.meta<FogOfWarToggled>(),
	BROADCAST_SENT: EM.meta<BroadcastSent>(),
	MATCH_ENDED: EM.meta<MatchEnded>(),
	VOTE_ABORTED: EM.meta<VoteAborted>(),
	LAYER_REQUEST_ADDED: EM.meta<LayerRequestAdded>(),
	LAYER_REQUEST_REMOVED: EM.meta<LayerRequestRemoved>(),
	SETTINGS_UPDATED: EM.meta<SettingsUpdated>(),
	SERVER_REGISTRY_CHANGED: EM.meta<ServerRegistryChanged>(),
	FILTER_CHANGED: EM.meta<FilterChanged>(),
	FILTER_CONTRIBUTOR_CHANGED: EM.meta<FilterContributorChanged>(),
	USER_ACCOUNT_CHANGED: EM.meta<UserAccountChanged>(),
	APP_STARTED: EM.meta<AppStarted>(),
	APP_RESTARTED: EM.meta<AppRestarted>(),
	BACKUP_CREATED: EM.meta<BackupCreated>(),
	PLUGIN_EVENT: EM.meta<PluginEvent>(),
	PLUGIN_DATA_PURGED: EM.meta<PluginDataPurged>(),
	MATCH_LAYERS_RECONCILED: EM.meta<MatchLayersReconciled>(),
	HISTORY_RETENTION_CHANGED: EM.meta<HistoryRetentionChanged>(),
	// checked per key rather than against one widened EventMeta, so a declaration whose extractor reads a field
	// its own event does not have fails here
} satisfies { [K in AppEventType]: EM.EventMeta<Extract<AppEvent, { type: K }>> }

function metaOf(e: AppEvent): EM.EventMeta<AppEvent> {
	return APP_EVENT_META[e.type] as EM.EventMeta<AppEvent>
}

// the players involved in an app event (targets, or a disbanded squad's members) as eos ids
export function involvedPlayerIds(e: AppEvent): SM.PlayerId[] {
	const ids: SM.PlayerId[] = []
	for (const playerMeta of metaOf(e).players) {
		for (const player of EM.iterAssocValues(playerMeta.get(e))) {
			ids.push(typeof player === 'object' ? SM.PlayerIds.getPlayerId(player.ids) : player)
		}
	}
	return ids
}

export function* iterAssocLayerIds(e: AppEvent): Generator<readonly [L.LayerId, EM.LayerAssocKind]> {
	yield* EM.iterAssocLayers(metaOf(e), e)
}

// What actually drove a QUEUE_UPDATED. A save the queue made for itself -- drawing the next layer, applying a vote
// result -- is a `user-edit` save with a system actor, which otherwise reads as "SLM updated the queue" and says
// nothing about what happened.
export type QueueUpdateKind = 'roll' | 'external-layer-change' | 'generated' | 'vote-result' | 'force-save' | 'save'

export function queueUpdateKind(e: QueueUpdated): QueueUpdateKind {
	if (e.trigger === 'roll') return 'roll'
	if (e.trigger === 'external-layer-change') return 'external-layer-change'
	// the op that triggered the save is the last of the span (see request-list-save)
	const triggerOp = e.ops[e.ops.length - 1]
	if (triggerOp?.op === 'queue-item-generated') return 'generated'
	if (triggerOp?.op === 'set-vote-result') return 'vote-result'
	return e.save?.force ? 'force-save' : 'save'
}

// the actor a queue sync was reconciling against, for an 'external-layer-change' save. Carried by the op rather than
// by the event's actor, which can only name a player (an rcon tool and a layer SLM merely found are both 'system').
export function queueUpdateExternalSource(e: QueueUpdated) {
	const triggerOp = e.ops[e.ops.length - 1]
	return triggerOp?.op === 'unshift-first-saved-layer' ? triggerOp.externalSource : undefined
}

// verb phrases with the actor left off, for the audit log
// ---- QUEUE_UPDATED change attribution ----

// a net change the save made to the queue, attributed to whoever caused it. the op span gives attribution (only
// client ops carry a userId) while the prevList/list diff gives the net effect, so churn that cancelled out before
// the save (an item added and then deleted again) produces no change at all.
export type QueueChange = { itemId: LL.ItemId; actor: Actor; layerIds: L.LayerId[]; isVote: boolean } & (
	| { kind: 'added'; index: number }
	| { kind: 'removed' }
	| { kind: 'edited'; prevLayerIds: L.LayerId[] }
	| { kind: 'moved'; fromIndex: number; toIndex: number }
)

/**
 * What an op is attributed to. The source is authoritative where it exists, since it is the only thing that
 * can name a plugin; `userId` covers the ops that carry no source.
 */
export function opActor(op: SLL.Operation): Actor {
	// backburner ops carry a `source` of their own that names a user rather than a provenance, so narrow on
	// the discriminant rather than the field name
	const source = 'source' in op && op.source && 'type' in op.source ? op.source : undefined
	if (source?.type === 'plugin') return { type: 'plugin', pluginId: source.pluginId }
	if (source?.type === 'manual') return { type: 'slm-user', userId: source.userId }
	if ('userId' in op && op.userId !== undefined) return { type: 'slm-user', userId: op.userId }
	return { type: 'system' }
}

// the last actor to touch each item within the op span. an op naming neither a source nor a user is a
// server-side op (a roll, a vote result, a generated item), which is SLM acting on its own.
function actorsByItem(ops: SLL.Operation[]): Map<LL.ItemId, Actor> {
	const actors = new Map<LL.ItemId, Actor>()
	for (const op of ops) {
		const actor = opActor(op)
		switch (op.op) {
			case 'add':
				// a vote item's choices are added with it, so attribute the whole subtree
				for (const { item } of LL.iterItems(op.items)) actors.set(item.itemId, actor)
				break
			case 'clear':
				for (const itemId of op.itemIds) actors.set(itemId, actor)
				break
			case 'queue-item-generated':
				actors.set(op.item.itemId, actor)
				break
			case 'set-vote-result':
				actors.set(op.voteItemId, actor)
				break
			case 'move':
			case 'swap-factions':
			case 'edit-layer':
			case 'add-tag':
			case 'remove-tag':
			case 'add-note':
			case 'edit-note':
			case 'delete-note':
			case 'clone':
			case 'configure-vote':
			case 'delete':
			case 'unshift-first-saved-layer':
				actors.set(op.itemId, actor)
				break
			// carry no item of their own: shift-first-saved-layer drops whatever was at the head of the queue, and
			// the rest are session bookkeeping. backburner ops never touch queue items (their attribution is
			// carried by the LAYER_REQUEST_* events instead)
			case 'init':
			case 'shift-first-saved-layer':
			case 'save':
			case 'save-completed':
			case 'reset-to-saved':
			case 'discard-abandoned-queue-edits':
			case 'discard-abandoned-request-edits':
			case 'backburner-add':
			case 'backburner-update':
			case 'backburner-remove':
			case 'backburner-reorder':
			case 'backburner-combine':
			case 'backburner-write-saved':
			case 'backburner-save':
			case 'backburner-reset':
				break
			default:
				assertNever(op)
		}
	}
	return actors
}

function itemLayerIds(item: LL.Item): L.LayerId[] {
	return [...LL.getAllItemLayerIds(item)]
}

// a vote item can change without any of its layers changing (its config was edited, or its result came in)
function voteStateOf(item: LL.Item) {
	if (!LL.isVoteItem(item)) return undefined
	return { config: item.voteConfig, result: item.endingVoteState }
}

// likewise an item can change by being tagged or annotated alone, which moves no layer id. Covers a vote item's choices
// too, since they carry their own tags and notes, and a change inside a vote reads as an edit of the vote.
function tagsOf(item: LL.Item) {
	return [...LL.iterItems([item])].map(({ item }) => (item.type === 'single-list-item' ? (item.tags ?? []) : []))
}

function notesOf(item: LL.Item) {
	return [...LL.iterItems([item])].map(({ item }) => (item.type === 'single-list-item' ? (item.notes ?? []) : []))
}

// the items that actually moved, as opposed to the ones a neighbouring insert or delete shifted along. the longest
// common subsequence of the surviving items is the part that held its relative order, so everything outside it is
// what someone dragged.
function movedItemIds(prevIds: LL.ItemId[], nextIds: LL.ItemId[]): Set<LL.ItemId> {
	const survivors = new Set(nextIds)
	const existing = new Set(prevIds)
	const before = prevIds.filter((id) => survivors.has(id))
	const after = nextIds.filter((id) => existing.has(id))
	const lengths: number[][] = Array.from({ length: before.length + 1 }, () => new Array(after.length + 1).fill(0))
	for (let i = before.length - 1; i >= 0; i--) {
		for (let j = after.length - 1; j >= 0; j--) {
			lengths[i][j] = before[i] === after[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1])
		}
	}
	const kept = new Set<LL.ItemId>()
	let i = 0
	let j = 0
	while (i < before.length && j < after.length) {
		if (before[i] === after[j]) {
			kept.add(before[i])
			i++
			j++
		} else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++
		else j++
	}
	return new Set(before.filter((id) => !kept.has(id)))
}

// the net changes a QUEUE_UPDATED made to the saved queue, in queue order (removals last). Only top-level items are
// reported: a change inside a vote item (a choice added, the config edited, the result set) reads as an edit of that
// item, which is how the queue displays it anyway.
export function summarizeQueueChanges(e: QueueUpdated): QueueChange[] {
	const actors = actorsByItem(e.ops)
	// an item nobody's op touched (its op span was truncated, or it predates this event) falls back to whoever the
	// event as a whole is attributed to
	const actorFor = (itemId: LL.ItemId) => actors.get(itemId) ?? e.actor
	const prev = new Map(e.prevList.map((item, index) => [item.itemId, { item, index }]))
	const next = new Map(e.list.map((item, index) => [item.itemId, { item, index }]))
	const moved = movedItemIds(
		e.prevList.map((i) => i.itemId),
		e.list.map((i) => i.itemId),
	)

	const changes: QueueChange[] = []
	for (const [itemId, { item, index }] of next) {
		const before = prev.get(itemId)
		const layerIds = itemLayerIds(item)
		const isVote = LL.isVoteItem(item)
		if (!before) {
			// an added item records who added it on the item itself, which survives even if the op span doesn't cover it
			const actor: Actor =
				item.source.type === 'manual'
					? { type: 'slm-user', userId: item.source.userId }
					: item.source.type === 'plugin'
						? { type: 'plugin', pluginId: item.source.pluginId }
						: actorFor(itemId)
			changes.push({ kind: 'added', itemId, index, layerIds, isVote, actor })
			continue
		}
		const prevLayerIds = itemLayerIds(before.item)
		if (
			!Obj.deepEqual(prevLayerIds, layerIds) ||
			!Obj.deepEqual(voteStateOf(before.item), voteStateOf(item)) ||
			!Obj.deepEqual(tagsOf(before.item), tagsOf(item)) ||
			!Obj.deepEqual(notesOf(before.item), notesOf(item))
		) {
			changes.push({ kind: 'edited', itemId, layerIds, prevLayerIds, isVote, actor: actorFor(itemId) })
		}
		if (moved.has(itemId)) {
			changes.push({ kind: 'moved', itemId, layerIds, isVote, fromIndex: before.index, toIndex: index, actor: actorFor(itemId) })
		}
	}
	for (const [itemId, { item }] of prev) {
		if (next.has(itemId)) continue
		changes.push({ kind: 'removed', itemId, layerIds: itemLayerIds(item), isVote: LL.isVoteItem(item), actor: actorFor(itemId) })
	}
	return changes
}

// ---- TEAMSWAPS_UPDATED change attribution ----

// a net change the save made to the queued teamswaps. only an added swap carries an actor: the swap records
// who queued that player (which is not necessarily whoever saved), while nothing records who removed one.
export type TeamswapChange = { playerId: SM.PlayerId; toTeam: MH.NormedTeamId } & (
	| { kind: 'added'; byUserId?: USR.UserId }
	| { kind: 'removed' }
)

// a player queued for a different team than before reads as an add (to the new team); the stale destination is not
// worth a line of its own
export function summarizeTeamswapChanges(e: TeamswapsUpdated): TeamswapChange[] {
	const changes: TeamswapChange[] = []
	for (const [playerId, _swap] of e.swaps) {
		const prev = e.prevSwaps.get(playerId)
		if (prev?.toTeam === _swap.toTeam) continue
		changes.push({ kind: 'added', playerId, toTeam: _swap.toTeam, byUserId: _swap.source.discordId })
	}
	for (const [playerId, _swap] of e.prevSwaps) {
		if (e.swaps.has(playerId)) continue
		changes.push({ kind: 'removed', playerId, toTeam: _swap.toTeam })
	}
	return changes
}

// constructs an app event, allocating its id and defaulting its time. instanceId is stamped later, at persist time.
export function create<E extends AppEvent>(fields: Omit<E, 'id' | 'time' | 'instanceId'> & { time?: number }): E {
	return {
		...fields,
		id: createAppEventId(),
		time: fields.time ?? Date.now(),
		instanceId: null,
	} as unknown as E
}

// ---- persistence (appEvents table); actor is flattened into columns, payload goes in the data blob ----

// bump when a payload changes shape in a way old rows can't satisfy; pair with per-type upgrades in fromRow.
export const CURRENT_APP_EVENT_VERSION = 1

export function toRow(e: AppEvent): SchemaModels.NewAppEvent {
	const { id, type, time, actor, serverId, matchId, causeId, instanceId, ...payload } = e
	// credentials are stripped here rather than only at the emitters: this is the one path into the table, so no
	// future caller can persist a connection password by forgetting to redact it first
	const redacted =
		e.type === 'SETTINGS_UPDATED' ? { ...payload, changes: redactSettingChanges((payload as SettingsUpdated).changes) } : payload
	return {
		id,
		type,
		time: new Date(time),
		actorType: actor.type,
		actorUserId: actor.type === 'slm-user' ? actor.userId : null,
		actorPlayerId: actor.type === 'ingame-user' ? actor.playerId : null,
		actorPluginId: actor.type === 'plugin' ? actor.pluginId : null,
		serverId,
		matchId,
		causeId,
		instanceId,
		version: CURRENT_APP_EVENT_VERSION,
		data: superjson.serialize(redacted) as any,
	}
}

// reconstructs an app event from a row and validates the payload blob against its schema. returns null (rather than
// throwing) for rows that don't parse -- an append-only audit log accumulates old-shaped rows across schema changes,
// and one bad row shouldn't break the whole feed/list. callers filter nulls (and may log the drop).
export function fromRow(row: SchemaModels.AppEvent): AppEvent | null {
	let payload: unknown
	try {
		payload = superjson.deserialize(row.data as any)
	} catch {
		return null
	}
	const actor =
		row.actorType === 'slm-user'
			? { type: 'slm-user', userId: row.actorUserId }
			: row.actorType === 'ingame-user'
				? { type: 'ingame-user', playerId: row.actorPlayerId }
				: row.actorType === 'plugin'
					? { type: 'plugin', pluginId: row.actorPluginId }
					: { type: 'system' }
	const candidate = {
		...(payload as object),
		id: row.id,
		type: row.type,
		time: row.time.getTime(),
		actor,
		serverId: row.serverId,
		matchId: row.matchId,
		causeId: row.causeId,
		instanceId: row.instanceId,
	}
	const parsed = AppEventSchema.safeParse(candidate)
	return parsed.success ? parsed.data : null
}
