import type * as SchemaModels from '$root/drizzle/schema.models'
import { createId } from '@/lib/id'
import type * as L from '@/models/layer'
import type * as LL from '@/models/layer-list.models'
import type * as SLL from '@/models/shared-layer-list'
import type * as SM from '@/models/squad.models'
import type * as USR from '@/models/users.models'
import superjson from 'superjson'

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
export type Actor =
	| { type: 'slm-user'; userId: USR.UserId } // web/orpc operator
	| { type: 'ingame-user'; playerId: SM.PlayerId } // chat-command sender (eos)
	| { type: 'system' } // automated: roll, balance, schedule, startup

export type Base = {
	id: AppEventId
	time: number
	actor: Actor
	// the server this action targets; null for global actions (settings/filters/users)
	serverId: string | null
	// feed replay/join key; null for global (never enters a server activity feed)
	matchId: number | null
	// provenance chain: the app event that caused this one (COMMAND_INVOKED -> VOTE_STARTED -> NEXT_LAYER_SET)
	causeId: AppEventId | null
}

// ---- discriminated payloads, one per action ----

export type PlayerWarned = {
	type: 'PLAYER_WARNED'
	message: string
	// the players this warn action targeted (eos ids)
	targets: SM.PlayerId[]
} & Base

export type SquadDisbanded = {
	type: 'SQUAD_DISBANDED'
	teamId: SM.TeamId
	// in-game squad id (not the unique/db id)
	squadId: number
	squadName: string
	// the players who were in the squad when it was disbanded (eos ids)
	members: SM.PlayerId[]
} & Base

export type PlayerRemovedFromSquad = {
	type: 'PLAYER_REMOVED_FROM_SQUAD'
	targets: SM.PlayerId[]
} & Base

export type TeamChangeForced = {
	type: 'TEAM_CHANGE_FORCED'
	targets: SM.PlayerId[]
} & Base

export type SquadRenamed = {
	type: 'SQUAD_RENAMED'
	teamId: SM.TeamId
	squadId: number
	// the squad's name at the time of the action (the rename resets it to the game default)
	squadName: string
} & Base

// pure-audit actions with no attributable server event
export type CommanderDemoted = {
	type: 'COMMANDER_DEMOTED'
	target: SM.PlayerId
} & Base

export type FogOfWarToggled = {
	type: 'FOG_OF_WAR_TOGGLED'
	enabled: boolean
} & Base

export type MatchEnded = {
	type: 'MATCH_ENDED'
} & Base

export type VoteStarted = {
	type: 'VOTE_STARTED'
	choiceCount: number
} & Base

export type VoteEnded = {
	type: 'VOTE_ENDED'
	reason: 'vote-timeout' | 'ended-early'
	winnerLayerId: L.LayerId | null
} & Base

export type VoteAborted = {
	type: 'VOTE_ABORTED'
} & Base

// a global (or per-server) settings change. global when serverId is null, per-server otherwise. audit-only.
export type SettingsUpdated = {
	type: 'SETTINGS_UPDATED'
} & Base

// server registry admin action. targetServerId (not serverId) so the servers FK cascade can't delete a
// SERVER_REGISTRY_CHANGED(deleted) event along with the server it records.
export type ServerRegistryChanged = {
	type: 'SERVER_REGISTRY_CHANGED'
	action: 'enabled' | 'disabled' | 'created' | 'deleted' | 'set-default'
	targetServerId: string
} & Base

export type FilterChanged = {
	type: 'FILTER_CHANGED'
	action: 'created' | 'updated' | 'deleted'
	filterId: string
} & Base

export type FilterContributorChanged = {
	type: 'FILTER_CONTRIBUTOR_CHANGED'
	action: 'added' | 'removed'
	filterId: string
} & Base

// a user acting on their own account
export type UserAccountChanged = {
	type: 'USER_ACCOUNT_CHANGED'
	action: 'steam-linked' | 'steam-unlinked' | 'nickname-updated'
} & Base

export type PlayerFlagsUpdated = {
	type: 'PLAYER_FLAGS_UPDATED'
	playerId: SM.PlayerId
	// the flags added and removed by this action (id + name resolved from the org's flag list)
	added: { id: string; name: string }[]
	removed: { id: string; name: string }[]
} & Base

export type QueueUpdated = {
	type: 'QUEUE_UPDATED'
	// all shared-layer-list operations since the last save (the opId span carried by request-list-save)
	ops: SLL.Operation[]
	// the saved queue before and after this save -- diffed to show the net change
	prevList: LL.List
	list: LL.List
} & Base

export type AppEvent =
	| PlayerWarned
	| SquadDisbanded
	| PlayerRemovedFromSquad
	| TeamChangeForced
	| SquadRenamed
	| CommanderDemoted
	| FogOfWarToggled
	| MatchEnded
	| VoteStarted
	| VoteEnded
	| VoteAborted
	| QueueUpdated
	| SettingsUpdated
	| ServerRegistryChanged
	| FilterChanged
	| FilterContributorChanged
	| UserAccountChanged
	| PlayerFlagsUpdated

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
			return []
		case 'PLAYER_FLAGS_UPDATED':
			return [e.playerId]
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
		case 'QUEUE_UPDATED':
			return 'updated the queue'
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
	}
}

// constructs an app event, allocating its id and defaulting its time
export function create<E extends AppEvent>(fields: Omit<E, 'id' | 'time'> & { time?: number }): E {
	return {
		...fields,
		id: createAppEventId(),
		time: fields.time ?? Date.now(),
	} as unknown as E
}

// ---- persistence (appEvents table); actor is flattened into columns, payload goes in the data blob ----

export function toRow(e: AppEvent): SchemaModels.NewAppEvent {
	const { id, type, time, actor, serverId, matchId, causeId, ...payload } = e
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
		data: superjson.serialize(payload) as any,
	}
}

export function fromRow(row: SchemaModels.AppEvent): AppEvent {
	const actor: Actor = row.actorType === 'slm-user'
		? { type: 'slm-user', userId: row.actorUserId! }
		: row.actorType === 'ingame-user'
		? { type: 'ingame-user', playerId: row.actorPlayerId! }
		: { type: 'system' }
	return {
		...(superjson.deserialize(row.data as any) as any),
		id: row.id,
		type: row.type,
		time: row.time.getTime(),
		actor,
		serverId: row.serverId,
		matchId: row.matchId,
		causeId: row.causeId,
	}
}
