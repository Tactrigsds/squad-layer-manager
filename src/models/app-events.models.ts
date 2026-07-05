import type * as SchemaModels from '$root/drizzle/schema.models'
import * as DH from '@/lib/display-helpers'
import { createId } from '@/lib/id'
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

export const PlayerWarnedSchema = event('PLAYER_WARNED', {
	message: z.string(),
	// the players this warn action targeted (eos ids)
	targets: z.array(SM.PlayerIdSchema),
})
export type PlayerWarned = z.infer<typeof PlayerWarnedSchema>

export const SquadDisbandedSchema = event('SQUAD_DISBANDED', {
	teamId: SM.TeamIdSchema,
	// in-game squad id (not the unique/db id)
	squadId: z.number(),
	squadName: z.string(),
	// the players who were in the squad when it was disbanded (eos ids)
	members: z.array(SM.PlayerIdSchema),
})
export type SquadDisbanded = z.infer<typeof SquadDisbandedSchema>

export const PlayerRemovedFromSquadSchema = event('PLAYER_REMOVED_FROM_SQUAD', { targets: z.array(SM.PlayerIdSchema) })
export type PlayerRemovedFromSquad = z.infer<typeof PlayerRemovedFromSquadSchema>

export const TeamChangeForcedSchema = event('TEAM_CHANGE_FORCED', { targets: z.array(SM.PlayerIdSchema) })
export type TeamChangeForced = z.infer<typeof TeamChangeForcedSchema>

export const SquadRenamedSchema = event('SQUAD_RENAMED', {
	teamId: SM.TeamIdSchema,
	squadId: z.number(),
	// the squad's name at the time of the action (the rename resets it to the game default)
	squadName: z.string(),
})
export type SquadRenamed = z.infer<typeof SquadRenamedSchema>

// pure-audit actions with no attributable server event
export const CommanderDemotedSchema = event('COMMANDER_DEMOTED', { target: SM.PlayerIdSchema })
export type CommanderDemoted = z.infer<typeof CommanderDemotedSchema>

export const FogOfWarToggledSchema = event('FOG_OF_WAR_TOGGLED', { enabled: z.boolean() })
export type FogOfWarToggled = z.infer<typeof FogOfWarToggledSchema>

export const MatchEndedSchema = event('MATCH_ENDED', {})
export type MatchEnded = z.infer<typeof MatchEndedSchema>

export const VoteStartedSchema = event('VOTE_STARTED', { choiceCount: z.number() })
export type VoteStarted = z.infer<typeof VoteStartedSchema>

export const VoteEndedSchema = event('VOTE_ENDED', {
	reason: z.enum(['vote-timeout', 'ended-early']),
	winnerLayerId: L.LayerIdSchema.nullable(),
})
export type VoteEnded = z.infer<typeof VoteEndedSchema>

export const VoteAbortedSchema = event('VOTE_ABORTED', {})
export type VoteAborted = z.infer<typeof VoteAbortedSchema>

// SLM process lifecycle. APP_STARTED fires on every boot (system actor); APP_RESTARTED is the intentional
// restart-slm admin action recorded before shutdown (slm-user actor).
export const AppStartedSchema = event('APP_STARTED', {})
export type AppStarted = z.infer<typeof AppStartedSchema>

export const AppRestartedSchema = event('APP_RESTARTED', {})
export type AppRestarted = z.infer<typeof AppRestartedSchema>

// a global (or per-server) settings change. global when serverId is null, per-server otherwise. audit-only.
export const SettingsUpdatedSchema = event('SETTINGS_UPDATED', {})
export type SettingsUpdated = z.infer<typeof SettingsUpdatedSchema>

// server registry admin action. targetServerId (not serverId) so the servers FK cascade can't delete a
// SERVER_REGISTRY_CHANGED(deleted) event along with the server it records.
export const ServerRegistryChangedSchema = event('SERVER_REGISTRY_CHANGED', {
	action: z.enum(['enabled', 'disabled', 'created', 'deleted', 'set-default']),
	targetServerId: z.string(),
})
export type ServerRegistryChanged = z.infer<typeof ServerRegistryChangedSchema>

export const FilterChangedSchema = event('FILTER_CHANGED', {
	action: z.enum(['created', 'updated', 'deleted']),
	filterId: z.string(),
})
export type FilterChanged = z.infer<typeof FilterChangedSchema>

export const FilterContributorChangedSchema = event('FILTER_CONTRIBUTOR_CHANGED', {
	action: z.enum(['added', 'removed']),
	filterId: z.string(),
})
export type FilterContributorChanged = z.infer<typeof FilterContributorChangedSchema>

// a user acting on their own account
export const UserAccountChangedSchema = event('USER_ACCOUNT_CHANGED', {
	action: z.enum(['steam-linked', 'steam-unlinked', 'nickname-updated']),
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
	SquadRenamedSchema,
	CommanderDemotedSchema,
	FogOfWarToggledSchema,
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
			return e.targets
		case 'SQUAD_DISBANDED':
			return e.members
		case 'COMMANDER_DEMOTED':
			return [e.target]
		case 'SQUAD_RENAMED':
		case 'FOG_OF_WAR_TOGGLED':
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
	switch (e.type) {
		case 'PLAYER_WARNED':
			return `warned ${players(e.targets.length)}: "${e.message}"`
		case 'SQUAD_DISBANDED':
			return `disbanded ${e.squadName} (Team ${e.teamId})`
		case 'PLAYER_REMOVED_FROM_SQUAD':
			return `removed ${players(e.targets.length)} from squad`
		case 'TEAM_CHANGE_FORCED':
			return `switched ${players(e.targets.length)} to the other team`
		case 'SQUAD_RENAMED':
			return `renamed ${e.squadName} (Team ${e.teamId})`
		case 'COMMANDER_DEMOTED':
			return 'demoted a commander'
		case 'FOG_OF_WAR_TOGGLED':
			return `turned fog of war ${e.enabled ? 'on' : 'off'}`
		case 'MATCH_ENDED':
			return 'ended the match'
		case 'VOTE_STARTED':
			return `started a vote (${e.choiceCount} ${e.choiceCount === 1 ? 'option' : 'options'})`
		case 'VOTE_ENDED':
			return e.reason === 'ended-early' ? 'ended a vote early' : 'a vote ended'
		case 'VOTE_ABORTED':
			return 'aborted a vote'
		case 'QUEUE_UPDATED': {
			const verb = e.trigger === 'roll'
				? 'advanced the queue on map change'
				: e.trigger === 'external-layer-change'
				? 'synced the queue to an external layer change'
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
		case 'SETTINGS_UPDATED':
			return e.serverId ? 'updated server settings' : 'updated global settings'
		case 'SERVER_REGISTRY_CHANGED': {
			const verb = e.action === 'set-default' ? 'set default' : e.action
			return `${verb} server "${e.targetServerId}"`
		}
		case 'FILTER_CHANGED':
			return `${e.action} filter ${e.filterId}`
		case 'FILTER_CONTRIBUTOR_CHANGED':
			return `${e.action === 'added' ? 'added a contributor to' : 'removed a contributor from'} filter ${e.filterId}`
		case 'USER_ACCOUNT_CHANGED':
			return e.action === 'steam-linked'
				? 'linked their Steam account'
				: e.action === 'steam-unlinked'
				? 'unlinked their Steam account'
				: 'updated their nickname'
		case 'PLAYER_FLAGS_UPDATED': {
			const changes = [...e.added.map(f => `+${f.name}`), ...e.removed.map(f => `−${f.name}`)].join(', ')
			return `updated Battlemetrics flags for player ${e.playerId}${changes ? `: ${changes}` : ''}`
		}
		case 'APP_STARTED':
			return 'SLM started'
		case 'APP_RESTARTED':
			return 'restarted SLM'
	}
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
		data: superjson.serialize(payload) as any,
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
