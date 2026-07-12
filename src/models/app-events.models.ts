import type * as SchemaModels from '$root/drizzle/schema.models'
import * as DH from '@/lib/display-helpers'
import { createId } from '@/lib/id'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import { formatHumanTime } from '@/lib/zod'
import * as AAR from '@/models/admin-action-reasons.models'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as SLL from '@/models/shared-layer-list'
import * as SM from '@/models/squad.models'
import * as USR from '@/models/users.models'
import superjson from 'superjson'
import { z } from 'zod'

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
	z.object({ type: z.literal('system') }), // automated: roll, balance, schedule, startup
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
	// provenance chain: the app event that caused this one (COMMAND_INVOKED -> VOTE_STARTED -> NEXT_LAYER_SET)
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

export const BroadcastSentSchema = event('BROADCAST_SENT', {
	message: z.string(),
	// set when the message came from a configured broadcast preset
	presetLabel: z.string().optional(),
})
export type BroadcastSent = z.infer<typeof BroadcastSentSchema>

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

// a settings value as it appeared in the audit log. Credentials (the rcon/sftp `connections` block) are recorded as
// having changed but their values are replaced with a marker, so the log never becomes a place to read secrets from.
// This matters beyond tidiness: the audit log is readable with global-settings:read, while the connection details
// themselves need server-settings:write-sensitive for the specific server.
export const REDACTED_SETTING = '[redacted]'
export const SettingChangeSchema = z.object({ path: z.string(), from: z.unknown(), to: z.unknown() })

// the settings subtree holding credentials. `connections` is the whole of it: rcon password, sftp host/user/password,
// and the log-receiver token all live under it, and it's the same subtree RBAC gates behind write-sensitive.
function isSensitiveSettingPath(path: string) {
	return path === 'connections' || path.startsWith('connections.')
}

// applied by toRow on the way to the database, so a caller that forgets to redact still can't persist a credential
export function redactSettingChanges(changes: SettingsUpdated['changes']): SettingsUpdated['changes'] {
	return changes?.map((c) => isSensitiveSettingPath(c.path) ? { ...c, from: REDACTED_SETTING, to: REDACTED_SETTING } : c)
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
	contributor: z.discriminatedUnion('type', [
		z.object({ type: z.literal('user'), userId: USR.UserIdSchema }),
		z.object({ type: z.literal('role'), roleId: z.string() }),
	]).optional(),
})
export type FilterContributorChanged = z.infer<typeof FilterContributorChangedSchema>

// a user acting on their own account
export const UserAccountChangedSchema = event('USER_ACCOUNT_CHANGED', {
	action: z.enum(['steam-linked', 'steam-unlinked', 'nickname-updated']),
	// for steam-linked / steam-unlinked: the accounts this action linked or unlinked (as strings; a steam64 id
	// doesn't survive a trip through JSON as a number)
	steamIds: z.array(z.string()).optional(),
	// for nickname-updated: null means the nickname was cleared, falling back to the discord username
	prevNickname: z.string().nullable().optional(),
	nickname: z.string().nullable().optional(),
})
export type UserAccountChanged = z.infer<typeof UserAccountChangedSchema>

export const PlayerFlagsUpdatedSchema = event('PLAYER_FLAGS_UPDATED', {
	playerId: SM.PlayerIdSchema,
	// the flags added and removed by this action (id + name resolved from the org's flag list)
	added: z.array(z.object({ id: z.string(), name: z.string() })),
	removed: z.array(z.object({ id: z.string(), name: z.string() })),
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
	save: z.object({
		force: z.boolean(),
		overrodeEditors: z.array(USR.UserIdSchema),
	}).optional(),
})
export type QueueUpdated = z.infer<typeof QueueUpdatedSchema>

// SLM set the next layer on the server. reason 'queue-updated' folds into its cause (the QUEUE_UPDATED linked via
// causeId) and is audit-only; reason 'override' is when SLM set the layer back over an external set, and gets a feed
// entry naming who it overrode.
export const MapSetSchema = event('MAP_SET', {
	layerId: L.LayerIdSchema,
	reason: z.enum(['queue-updated', 'override']),
	// for reason 'override': the external actor whose set SLM overrode
	overrode: z.discriminatedUnion('type', [
		z.object({ type: z.literal('player'), playerId: SM.PlayerIdSchema }),
		z.object({ type: z.literal('rcon') }),
	]).optional(),
})
export type MapSet = z.infer<typeof MapSetSchema>

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
	PlayerTimedOutSchema,
	TimeoutCancelledSchema,
	MatchEndedSchema,
	VoteStartedSchema,
	VoteEndedSchema,
	VoteAbortedSchema,
	QueueUpdatedSchema,
	SettingsUpdatedSchema,
	ServerRegistryChangedSchema,
	FilterChangedSchema,
	FilterContributorChangedSchema,
	UserAccountChangedSchema,
	PlayerFlagsUpdatedSchema,
	AppStartedSchema,
	AppRestartedSchema,
	MapSetSchema,
])
export type AppEvent = z.infer<typeof AppEventSchema>

export type AppEventType = AppEvent['type']

// the players involved in an app event (targets, or a disbanded squad's members) as eos ids
export function involvedPlayerIds(e: AppEvent): SM.PlayerId[] {
	switch (e.type) {
		case 'PLAYER_WARNED':
		case 'PLAYER_REMOVED_FROM_SQUAD':
		case 'TEAM_CHANGE_FORCED':
		case 'PLAYER_KILLED':
			return e.targets
		case 'SQUAD_DISBANDED':
			return e.members
		case 'COMMANDER_DEMOTED':
		case 'PLAYER_TIMED_OUT':
		case 'TIMEOUT_CANCELLED':
			return [e.target]
		case 'SQUAD_RENAMED':
		case 'FOG_OF_WAR_TOGGLED':
		case 'BROADCAST_SENT':
		case 'MATCH_ENDED':
		case 'VOTE_STARTED':
		case 'VOTE_ENDED':
		case 'VOTE_ABORTED':
		case 'QUEUE_UPDATED':
		case 'SETTINGS_UPDATED':
		case 'SERVER_REGISTRY_CHANGED':
		case 'FILTER_CHANGED':
		case 'FILTER_CONTRIBUTOR_CHANGED':
		case 'USER_ACCOUNT_CHANGED':
		case 'APP_STARTED':
		case 'APP_RESTARTED':
			return []
		case 'PLAYER_FLAGS_UPDATED':
			return [e.playerId]
		case 'MAP_SET':
			return e.overrode?.type === 'player' ? [e.overrode.playerId] : []
	}
}

// a short human-readable description of the action, WITHOUT the actor (the caller prepends the actor's name).
// used by the audit log; the activity feed has its own richer per-type renderers.
export function describeAppEvent(e: AppEvent): string {
	const players = (n: number) => `${n} ${n === 1 ? 'player' : 'players'}`
	const forReason = (reason: AppliedActionReason | undefined) => reason?.label ? ` for ${reason.label}` : ''
	switch (e.type) {
		case 'PLAYER_WARNED':
			// preset-reason warns embed the label in the delivered message, so it isn't repeated here
			return `warned ${players(e.targets.length)}: "${e.message}"`
		case 'SQUAD_DISBANDED':
			return `disbanded ${e.squadName} (Team ${e.teamId})${forReason(e.reason)}`
		case 'PLAYER_REMOVED_FROM_SQUAD':
			return `removed ${players(e.targets.length)} from squad${forReason(e.reason)}`
		case 'TEAM_CHANGE_FORCED':
			return `switched ${players(e.targets.length)} to the other team`
		case 'PLAYER_KILLED':
			// preset-reason kills embed the label in the delivered reason, so it isn't repeated here
			return `killed ${players(e.targets.length)}${e.reason ? `: "${e.reason}"` : ''}`
		case 'SQUAD_RENAMED':
			return `renamed ${e.squadName} (Team ${e.teamId})`
		case 'COMMANDER_DEMOTED':
			return `demoted a commander${forReason(e.reason)}`
		case 'FOG_OF_WAR_TOGGLED':
			return `turned fog of war ${e.enabled ? 'on' : 'off'}`
		case 'BROADCAST_SENT':
			// preset broadcasts embed nothing extra; the label is implicit in the configured message
			return `broadcast: "${e.message}"`
		case 'PLAYER_TIMED_OUT':
			return `kicked 1 player with a ${formatHumanTime(e.durationMs)} timeout${e.reason?.label ? ` for ${e.reason.label}` : ''}`
		case 'TIMEOUT_CANCELLED':
			return `cancelled a player's timeout`
		case 'MATCH_ENDED':
			return 'ended the match'
		case 'VOTE_STARTED':
			return `started a vote (${e.choiceCount} ${e.choiceCount === 1 ? 'option' : 'options'})`
		case 'VOTE_ENDED': {
			const verb = e.reason === 'ended-early' ? 'ended a vote early' : 'a vote ended'
			const winner = e.winnerLayerId ? `, ${DH.toShortLayerNameFromId(e.winnerLayerId)} won` : ''
			const turnout = e.totalVotes !== undefined ? ` (${e.totalVotes} ${e.totalVotes === 1 ? 'vote' : 'votes'})` : ''
			return `${verb}${winner}${turnout}`
		}
		case 'VOTE_ABORTED':
			return 'aborted a vote'
		case 'QUEUE_UPDATED': {
			const verb = e.trigger === 'roll'
				? 'advanced the queue on map change'
				: e.trigger === 'external-layer-change'
				? 'synced the queue to an external layer change'
				: e.save?.force
				? 'force-saved the queue'
				: 'updated the queue'
			// user-edit / roll saves have a companion MAP_SET row that states the next layer; external syncs don't
			if (e.trigger !== 'external-layer-change') return verb
			const nextBefore = LL.getNextLayerId(e.prevList)
			const nextAfter = LL.getNextLayerId(e.list)
			return nextAfter !== null && nextAfter !== nextBefore
				? `${verb}, next layer now ${DH.toShortLayerNameFromId(nextAfter)}`
				: verb
		}
		case 'MAP_SET': {
			const layer = DH.toShortLayerNameFromId(e.layerId)
			if (e.reason === 'override') {
				const who = e.overrode?.type === 'player' ? ' by an in-game admin' : e.overrode?.type === 'rcon' ? ' by another RCON tool' : ''
				return `overrode an external layer set${who}, next layer set to ${layer}`
			}
			return `set next layer to ${layer}`
		}
		case 'SETTINGS_UPDATED': {
			const scope = e.serverId ? 'server settings' : 'global settings'
			if (!e.changes || e.changes.length === 0) return `updated ${scope}`
			// the paths are the point of the entry; the values are in the expanded payload
			const shown = e.changes.slice(0, 3).map(c => c.path).join(', ')
			const rest = e.changes.length > 3 ? ` and ${e.changes.length - 3} more` : ''
			return `updated ${scope}: ${shown}${rest}`
		}
		case 'SERVER_REGISTRY_CHANGED': {
			const verb = e.action === 'set-default' ? 'set default' : e.action
			return `${verb} server "${e.targetServerName ?? e.targetServerId}"`
		}
		case 'FILTER_CHANGED': {
			const name = e.filterName ? `"${e.filterName}"` : e.filterId
			const fields = e.action === 'updated' && e.changedFields?.length ? ` (${e.changedFields.join(', ')})` : ''
			return `${e.action} filter ${name}${fields}`
		}
		case 'FILTER_CONTRIBUTOR_CHANGED': {
			const name = e.filterName ? `"${e.filterName}"` : e.filterId
			const who = e.contributor?.type === 'role' ? `role ${e.contributor.roleId}` : 'a contributor'
			return e.action === 'added' ? `added ${who} to filter ${name}` : `removed ${who} from filter ${name}`
		}
		case 'USER_ACCOUNT_CHANGED': {
			const count = e.steamIds?.length ?? 0
			const accounts = count > 1 ? `${count} Steam accounts` : 'their Steam account'
			if (e.action === 'steam-linked') return `linked ${accounts}`
			if (e.action === 'steam-unlinked') return `unlinked ${accounts}`
			if (e.nickname === undefined) return 'updated their nickname'
			return e.nickname === null ? 'cleared their nickname' : `set their nickname to "${e.nickname}"`
		}
		case 'PLAYER_FLAGS_UPDATED': {
			const changes = [...e.added.map(f => `+${f.name}`), ...e.removed.map(f => `−${f.name}`)].join(', ')
			return `updated Battlemetrics flags for player ${e.playerId}${changes ? `: ${changes}` : ''}`
		}
		case 'APP_STARTED':
			return `SLM started${e.version ? ` (${e.version})` : ''}`
		case 'APP_RESTARTED':
			return 'restarted SLM'
	}
}

// ---- QUEUE_UPDATED change attribution ----

// a net change the save made to the queue, attributed to whoever caused it. the op span gives attribution (only
// client ops carry a userId) while the prevList/list diff gives the net effect, so churn that cancelled out before
// the save (an item added and then deleted again) produces no change at all.
export type QueueChange =
	& { itemId: LL.ItemId; actor: Actor; layerIds: L.LayerId[]; isVote: boolean }
	& (
		| { kind: 'added'; index: number }
		| { kind: 'removed' }
		| { kind: 'edited'; prevLayerIds: L.LayerId[] }
		| { kind: 'moved'; fromIndex: number; toIndex: number }
	)

// the last actor to touch each item within the op span. an op without a userId is a server-side op (a roll, a vote
// result, a generated item), which is SLM acting on its own.
function actorsByItem(ops: SLL.Operation[]): Map<LL.ItemId, Actor> {
	const actors = new Map<LL.ItemId, Actor>()
	for (const op of ops) {
		const actor: Actor = 'userId' in op && op.userId !== undefined ? { type: 'slm-user', userId: op.userId } : { type: 'system' }
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
			case 'clone':
			case 'configure-vote':
			case 'delete':
			case 'unshift-first-saved-layer':
				actors.set(op.itemId, actor)
				break
			// carry no item of their own: shift-first-saved-layer drops whatever was at the head of the queue, and
			// the rest are session bookkeeping
			case 'init':
			case 'shift-first-saved-layer':
			case 'save':
			case 'save-completed':
			case 'reset-to-saved':
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

// the items that actually moved, as opposed to the ones a neighbouring insert or delete shifted along. the longest
// common subsequence of the surviving items is the part that held its relative order, so everything outside it is
// what someone dragged.
function movedItemIds(prevIds: LL.ItemId[], nextIds: LL.ItemId[]): Set<LL.ItemId> {
	const survivors = new Set(nextIds)
	const existing = new Set(prevIds)
	const before = prevIds.filter(id => survivors.has(id))
	const after = nextIds.filter(id => existing.has(id))
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
	return new Set(before.filter(id => !kept.has(id)))
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
	const moved = movedItemIds(e.prevList.map(i => i.itemId), e.list.map(i => i.itemId))

	const changes: QueueChange[] = []
	for (const [itemId, { item, index }] of next) {
		const before = prev.get(itemId)
		const layerIds = itemLayerIds(item)
		const isVote = LL.isVoteItem(item)
		if (!before) {
			// an added item records who added it on the item itself, which survives even if the op span doesn't cover it
			const actor: Actor = item.source.type === 'manual' ? { type: 'slm-user', userId: item.source.userId } : actorFor(itemId)
			changes.push({ kind: 'added', itemId, index, layerIds, isVote, actor })
			continue
		}
		const prevLayerIds = itemLayerIds(before.item)
		if (!Obj.deepEqual(prevLayerIds, layerIds) || !Obj.deepEqual(voteStateOf(before.item), voteStateOf(item))) {
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
	const redacted = e.type === 'SETTINGS_UPDATED'
		? { ...payload, changes: redactSettingChanges((payload as SettingsUpdated).changes) }
		: payload
	return {
		id,
		type,
		time: new Date(time),
		actorType: actor.type,
		actorUserId: actor.type === 'slm-user' ? actor.userId : null,
		actorPlayerId: actor.type === 'ingame-user' ? actor.playerId : null,
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
	const actor = row.actorType === 'slm-user'
		? { type: 'slm-user', userId: row.actorUserId }
		: row.actorType === 'ingame-user'
		? { type: 'ingame-user', playerId: row.actorPlayerId }
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
