import type * as SchemaModels from '$root/drizzle/schema.models'
import * as Obj from '@/lib/object'
import type * as L from '@/models/layer'
import * as SM from '@/models/squad.models'
import superjson from 'superjson'
import { type Base, type EventMeta, meta } from './server-events-base.models'

export type MapSet = {
	type: 'MAP_SET'
	layerId: L.LayerId
} & Base
export const MAP_SET_META = meta()

export type NewGame = {
	type: 'NEW_GAME'
	source: 'slm-started' | 'rcon-reconnected' | 'new-game-detected'
	layerId: L.LayerId
	state: SM.Teams
} & Base
export const NEW_GAME_META = meta({ players: [{ assocType: 'game-participant', path: '$.state.players[*]' }] })

export type Reset = {
	type: 'RESET'
	source: 'slm-started' | 'rcon-reconnected'
	state: SM.Teams
} & Base

export const RESET_META = meta({ players: [{ assocType: 'game-participant', path: '$.state.players[*]' }] })

export type RconConnected = {
	type: 'RCON_CONNECTED'
	reconnected: boolean
} & Base
export const RCON_CONNECTED_META = meta()

export type RconDisconnected = {
	type: 'RCON_DISCONNECTED'
} & Base
export const RCON_DISCONNECTED_META = meta()

export type RoundEnded = {
	type: 'ROUND_ENDED'
} & Base
export const ROUND_ENDED_META = meta()

export type PlayerConnected<P = SM.Player> =
	& {
		type: 'PLAYER_CONNECTED'
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_CONNECTED_META = meta({ players: [{ assocType: 'player' }] })

export type PlayerDisconnected<P = SM.PlayerId> =
	& {
		type: 'PLAYER_DISCONNECTED'
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_DISCONNECTED_META = meta({ players: [{ assocType: 'player' }] })

// TODO: we should probably include the uniquely created database id here to simplify a bunch of code related to resolving squad instances, and use that for all references to squad in these events
export type SquadCreated = {
	type: 'SQUAD_CREATED'
	squad: SM.Squad
} & Base

export const SQUAD_CREATED_META = meta({ squads: ['$.squad'], players: [{ assocType: 'player', path: '$.squad.creator' }] })

export type ChatMessage<P = SM.PlayerId> =
	& {
		type: 'CHAT_MESSAGE'
		message: string
		// has indirect SquadAssoc through channel if ChatSquad
		channel: SM.ChatChannel
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const CHAT_MESSAGE_META = meta({ players: [{ assocType: 'player' }] })

export type AdminBroadcast = {
	type: 'ADMIN_BROADCAST'
	message: string
	from: SM.LogEvents.AdminBroadcast['from']
} & Base
export const ADMIN_BROADCAST_META = meta()

// synthetic events from player state
export type PlayerDetailsChanged<P = SM.PlayerId> =
	& {
		type: 'PLAYER_DETAILS_CHANGED'
		details: Pick<SM.Player, (typeof SM.PLAYER_DETAILS)[number]>
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_DETAILS_CHANGED_META = meta({ players: [{ assocType: 'player' }] })

export type PlayerChangedTeam<P = SM.PlayerId> =
	& {
		type: 'PLAYER_CHANGED_TEAM'
		newTeamId: SM.TeamId | null
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_CHANGED_TEAM_META = meta({ players: [{ assocType: 'player' }] })

// can originate if the player manually leaves the squad, or is removed for some other reason
export type PlayerLeftSquad<P = SM.PlayerId> =
	& {
		type: 'PLAYER_LEFT_SQUAD'
		squadId: SM.SquadId
		teamId: SM.TeamId
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_LEFT_SQUAD_META = meta({ players: [{ assocType: 'player' }] })

// this event is redundant in terms of state transfer, as it could be inferred as the last player leaving a particular squad
export type SquadDisbanded = {
	type: 'SQUAD_DISBANDED'
	squadId: SM.SquadId
	teamId: SM.TeamId
} & Base
export const SQUAD_DISBANDED_META = meta({ squads: ['$'] })

export type SquadDetailsChanged = {
	type: 'SQUAD_DETAILS_CHANGED'
	squadId: SM.SquadId
	teamId: SM.TeamId
	details: {
		locked?: boolean
	}
} & Base
export const SQUAD_DETAILS_CHANGED_META = meta({ squads: ['$'] })

export type SquadRenamed = {
	type: 'SQUAD_RENAMED'
	squadId: SM.SquadId
	teamId: SM.TeamId
	oldSquadName: string
	newSquadName: string
} & Base
export const SQUAD_RENAMED_META = meta({ squads: ['$'] })

/**
 * Player joined pre-existing squad
 */
export type PlayerJoinedSquad<P = SM.PlayerId> =
	& {
		type: 'PLAYER_JOINED_SQUAD'
		squadId: SM.SquadId
		teamId: SM.TeamId
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_JOINED_SQUAD_META = meta({ players: [{ assocType: 'player' }], squads: ['$'] })

export type PlayerPromotedToLeader<P = SM.PlayerId> =
	& {
		type: 'PLAYER_PROMOTED_TO_LEADER'
		squadId: SM.SquadId
		teamId: SM.TeamId
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_PROMOTED_TO_LEADER_META = meta({ players: [{ assocType: 'player' }], squads: ['$'] })

export type PlayerKicked<P = SM.PlayerId> =
	& {
		type: 'PLAYER_KICKED'
		reason?: string
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const PLAYER_KICKED_META = meta({ players: [{ assocType: 'player' }] })

export type PossessedAdminCamera<P = SM.PlayerId> =
	& {
		type: 'POSSESSED_ADMIN_CAMERA'
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const POSSESSED_ADMIN_CAMERA_META = meta({ players: [{ assocType: 'player' }] })

export type UnpossessedAdminCamera<P = SM.PlayerId> =
	& {
		type: 'UNPOSSESSED_ADMIN_CAMERA'
	}
	& SM.PlayerAssoc<'player', P>
	& Base
export const UNPOSSESSED_ADMIN_CAMERA_META = meta({ players: [{ assocType: 'player' }] })

export type PlayerBanned<P = SM.PlayerId> = { type: 'PLAYER_BANNED'; interval: string } & SM.PlayerAssoc<'player', P> & Base
export const PLAYER_BANNED_META = meta({ players: [{ assocType: 'player' }] })

export type PlayerWarned<P = SM.PlayerId> = { type: 'PLAYER_WARNED'; reason: string } & SM.PlayerAssoc<'player', P> & Base
export const PLAYER_WARNED_META = meta({ players: [{ assocType: 'player' }] })

export type PlayerDied<P = SM.PlayerId> =
	& {
		type: 'PLAYER_DIED'
		damage: number
		weapon: string
		variant: PlayerWoundedOrDiedVariant
	}
	& SM.PlayerAssoc<'victim', P>
	& SM.PlayerAssoc<'attacker', P>
	& Base

export const PLAYER_DIED_META = meta({ players: [{ assocType: 'victim' }, { assocType: 'attacker' }] })

export type PlayerWoundedOrDiedVariant = 'normal' | 'suicide' | 'teamkill'

export type PlayerWounded<P = SM.PlayerId> =
	& {
		type: 'PLAYER_WOUNDED'
		damage: number
		weapon: string
		variant: PlayerWoundedOrDiedVariant
	}
	& SM.PlayerAssoc<'victim', P>
	& SM.PlayerAssoc<'attacker', P>
	& Base

export const PLAYER_WOUNDED_META = meta({ players: [{ assocType: 'victim' }, { assocType: 'attacker' }] })

export type Event<P = SM.PlayerId> =
	| MapSet
	| NewGame
	| Reset
	| RconConnected
	| RconDisconnected
	| RoundEnded
	| PlayerConnected<SM.Player>
	| PlayerDisconnected<P>
	| SquadCreated
	| ChatMessage<P>
	| AdminBroadcast
	// from rcon
	| PossessedAdminCamera<P>
	| UnpossessedAdminCamera<P>
	| PlayerKicked<P>
	| PlayerBanned<P>
	| PlayerWarned<P>
	| PlayerDied<P>
	| PlayerWounded<P>
	// synthetic
	| PlayerDetailsChanged<P>
	| PlayerChangedTeam<P>
	| PlayerLeftSquad<P>
	| SquadDisbanded
	| SquadDetailsChanged
	| SquadRenamed
	| PlayerJoinedSquad<P>
	| PlayerPromotedToLeader<P>

export const EVENT_META = {
	MAP_SET: MAP_SET_META,
	NEW_GAME: NEW_GAME_META,
	RESET: RESET_META,
	RCON_CONNECTED: RCON_CONNECTED_META,
	RCON_DISCONNECTED: RCON_DISCONNECTED_META,
	ROUND_ENDED: ROUND_ENDED_META,
	PLAYER_CONNECTED: PLAYER_CONNECTED_META,
	PLAYER_DISCONNECTED: PLAYER_DISCONNECTED_META,
	SQUAD_CREATED: SQUAD_CREATED_META,
	CHAT_MESSAGE: CHAT_MESSAGE_META,
	ADMIN_BROADCAST: ADMIN_BROADCAST_META,
	PLAYER_DETAILS_CHANGED: PLAYER_DETAILS_CHANGED_META,
	PLAYER_CHANGED_TEAM: PLAYER_CHANGED_TEAM_META,
	PLAYER_LEFT_SQUAD: PLAYER_LEFT_SQUAD_META,
	SQUAD_DISBANDED: SQUAD_DISBANDED_META,
	SQUAD_DETAILS_CHANGED: SQUAD_DETAILS_CHANGED_META,
	SQUAD_RENAMED: SQUAD_RENAMED_META,
	PLAYER_JOINED_SQUAD: PLAYER_JOINED_SQUAD_META,
	PLAYER_PROMOTED_TO_LEADER: PLAYER_PROMOTED_TO_LEADER_META,
	PLAYER_KICKED: PLAYER_KICKED_META,
	POSSESSED_ADMIN_CAMERA: POSSESSED_ADMIN_CAMERA_META,
	UNPOSSESSED_ADMIN_CAMERA: UNPOSSESSED_ADMIN_CAMERA_META,
	PLAYER_BANNED: PLAYER_BANNED_META,
	PLAYER_WARNED: PLAYER_WARNED_META,
	PLAYER_DIED: PLAYER_DIED_META,
	PLAYER_WOUNDED: PLAYER_WOUNDED_META,
} satisfies Record<Event['type'], EventMeta>

// TODO Zod?
export function fromEventRow(row: SchemaModels.ServerEvent): Event {
	return {
		...(superjson.deserialize(row.data as any, { inPlace: true }) as any),
		id: row.id,
		type: row.type,
		time: row.time.getTime(),
		matchId: row.matchId,
	}
}

export function* iterAssocPlayers(event: Event<SM.PlayerId | SM.Player>) {
	const meta = EVENT_META[event.type]
	for (const playerMeta of meta.players) {
		let values: (SM.Player | SM.PlayerId | undefined | null)[]
		if (playerMeta.path) {
			values = Obj.queryPath<SM.Player | SM.PlayerId>(playerMeta.path, event)
		} else {
			// @ts-expect-error idgaf
			values = [event[playerMeta.assocType]]
		}

		for (const value of values) {
			if (!value) continue
			yield [value, playerMeta.assocType] as const
		}
	}
}

export function* iterAssocPlayerIds(event: Event<SM.Player | SM.PlayerId>) {
	for (const [player, assocType] of iterAssocPlayers(event)) {
		if (typeof player === 'object') {
			yield [SM.PlayerIds.getPlayerId(player.ids), assocType] as const
		} else {
			yield [player, assocType] as const
		}
	}
}

export function* iterAssocSquads(event: Event) {
	const meta = EVENT_META[event.type]
	for (const path of meta.squads) {
		const results = Obj.queryPath<any>(path, event)

		for (const result of results) {
			if (!result || typeof result !== 'object') continue
			if (!SM.Squads.isSquadKeyLike(result)) continue
			yield { squadId: result.squadId, teamId: result.teamId } as SM.Squads.Key | SM.Squad
		}
	}
}
