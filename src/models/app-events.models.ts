import type * as SchemaModels from '$root/drizzle/schema.models'
import { createId } from '@/lib/id'
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

export type AppEvent =
	| PlayerWarned
	| SquadDisbanded
	| PlayerRemovedFromSquad
	| TeamChangeForced
	| SquadRenamed
	| CommanderDemoted
	| FogOfWarToggled
	| MatchEnded

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
			return []
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
