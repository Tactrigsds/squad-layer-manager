import * as SM from '@/models/squad.models'

export type PlayerRef = string

export type Channel = SM.ChatChannel

export namespace Events {
	// identical to upstream events, but no ip information
	export type PlayerConnected = {
		type: 'PLAYER_CONNECTED'
		time: Date
		player: SM.PlayerIds.Type
	}
	export type PlayerDisconnected = {
		type: 'PLAYER_DISCONNECTED'
		time: Date
		player: SM.PlayerIds.Type
	}
}

export type Event =
	// from logs
	| SM.Events.NewGame
	| SM.Events.RoundEnded
	// from rcon
	| SM.RconEvents.ChatMessage
	| SM.RconEvents.PossessedAdminCamera
	| SM.RconEvents.UnpossessedAdminCamera
	| SM.RconEvents.PlayerKicked
	| SM.RconEvents.SquadCreated
	| SM.RconEvents.PlayerBanned
	| SM.RconEvents.PlayerWarned
	// modified for frontend
	| Events.PlayerConnected
	| Events.PlayerDisconnected

export type SyncEvent = {
	type: 'INIT'
	time: Date
	state: ChatState
	players: SM.Player[]
	squads: SM.Squad[]
	buffer: Event[]
} | {
	type: 'PLAYERS_UPDATE'
	upserted: SM.Player[]
	removed: SM.PlayerIds.Type[]
} | {
	type: 'SQUADS_UPDATE'
	upserted: SM.Squad[]
	removed: SM.SquadId[]
}

export const BUFFER_MAX_SIZE = 512
export const BUFFER_EVENT_TYPE_EXCLUSIONS = ['PLAYERS_UPDATE', 'SQUADS_UPDATE', 'INIT'] as const

export type ChatState = {
	players: SM.Player[]
	squads: SM.Squad[]

	connectedPlayers: SM.PlayerIds.Type[]
	disconnectedPlayers: SM.PlayerIds.Type[]
	createdSquads: Set<SM.SquadId>

	eventBuffer: Event[]
}

export function handleEvent(state: ChatState, event: Event | SyncEvent) {
	if (event.type === 'INIT') {
		state.players = event.players
		state.squads = event.squads
		state.eventBuffer = event.buffer
		return
	}

	// TODO implement
	if (event.type === 'PLAYERS_UPDATE' || event.type === 'SQUADS_UPDATE') {
		return
	}

	if (event.type === 'PLAYER_CONNECTED') {
		SM.PlayerIds.upsert(state.connectedPlayers, event.player)
	} else if (event.type === 'PLAYER_DISCONNECTED') {
		SM.PlayerIds.remove(state.disconnectedPlayers, event.player)
	}

	if (event.type === 'SQUAD_CREATED') {
		state.createdSquads.add(event.squadID)
	}

	pushEventToBuffer(state, event)
}

export function pushEventToBuffer(state: ChatState, event: Event) {
	const buffer = state.eventBuffer
	let i = buffer.length - 1
	for (; i < buffer.length; i++) {
		const current = buffer[i]
		if (current.time < event.time) {
			break
		}
	}
	buffer.splice(i, 0, event)
	const over = BUFFER_MAX_SIZE - buffer.length
	buffer.splice(0, over)
}
