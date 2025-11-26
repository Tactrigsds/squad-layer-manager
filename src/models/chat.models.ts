import * as Obj from '@/lib/object'
import * as SM from '@/models/squad.models'
import { mutateMergeDeep } from '@tanstack/react-form'

export type PlayerRef = string

export type Channel = SM.ChatChannelType

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

export type SyncEvent = {
	type: 'INIT'
	state: ChatState
}

export type InterpolableState = {
	players: SM.Player[]
	squads: SM.Squad[]
}

// event with snapshot of relevant data
export type Event = NonNullable<ReturnType<typeof interpolateEvent>>

export type ChatState = {
	initialState: InterpolableState
	rawEventBuffer: SM.Events.Event[]

	interpolatedState: InterpolableState
	eventBuffer: Event[]
}
export const INITIAL_CHAT_STATE: ChatState = {
	initialState: {
		players: [],
		squads: [],
	},

	rawEventBuffer: [],
	interpolatedState: {
		players: [],
		squads: [],
	},
	eventBuffer: [],
}

export function handleEvent(state: ChatState, event: SM.Events.Event | SyncEvent) {
	if (event.type === 'INIT') {
		Object.assign(state, event.state)
		return
	}

	const rawBuffer = state.rawEventBuffer
	let i = rawBuffer.length - 1
	for (; i >= 0; i--) {
		const current = rawBuffer[i]
		if (current.time < event.time) {
			break
		}
	}
	const mutatedIndex = i + 1
	rawBuffer.splice(mutatedIndex, 0, event)
	if (mutatedIndex < state.eventBuffer.length) {
		// we need to re-interpolate from starting conditions because we received an out-of-order event. could maybe store periodic savepoints to handle really massive buffers efficiently
		let newState = Obj.deepClone(state.initialState)
		state.eventBuffer = []
		for (const event of rawBuffer.slice(0, mutatedIndex)) {
			const interpolated = interpolateEvent(newState, event)
			if (!interpolated) continue
			state.eventBuffer.push(interpolated)
		}
	}

	// in most cases we'll just have the added event to process here
	for (const event of rawBuffer.slice(mutatedIndex)) {
		const interpolated = interpolateEvent(state.interpolatedState, event)
		if (!interpolated) continue
		state.eventBuffer.push(interpolated)
	}
}

// TODO pass in logger
export function interpolateEvent(state: InterpolableState, event: SM.Events.Event) {
	// NOTE: assume that state is deeply mutable. clone data we want to include with events. for now just clone anything that's a mutable data-structure
	switch (event.type) {
		case 'NEW_GAME':
		case 'ROUND_ENDED':
			return event

		case 'PLAYER_CONNECTED': {
			if (SM.PlayerIds.find(state.players, p => p.ids, event.player.ids)) {
				console.warn(`Player ${SM.PlayerIds.prettyPrint(event.player.ids)} connected but was already in the player list`)
				return
			}
			// this upsert merges ids in state.players, so we want to pass the one with the full set of ids. probably not useful but good for continuity
			const player = SM.PlayerIds.upsert(state.players, p => p.ids, event.player)
			return {
				...event,
				player: Obj.deepClone(player),
			}
		}

		case 'PLAYER_DISCONNECTED': {
			const index = SM.PlayerIds.indexOf(state.players, p => p.ids, event.playerIds)
			if (index === -1) {
				console.warn(`Player ${SM.PlayerIds.prettyPrint(event.playerIds)} disconnected but was not found in the player list`)
				return
			}
			const [player] = state.players.splice(index, 1)
			return {
				...event,
				player: Obj.deepClone(player),
			}
		}

		case 'SQUAD_CREATED': {
			state.squads.push(event.squad)
			const creator = SM.PlayerIds.find(state.players, p => p.ids, event.squad.creatorIds)
			if (!creator) {
				console.warn(`Squad ${event.squad.squadId} created by unknown player ${SM.PlayerIds.prettyPrint(event.squad.creatorIds)}`)
				return
			}
			return {
				...event,
				creator: Obj.deepClone(creator),
			}
		}

		case 'PLAYER_BANNED':
		case 'PLAYER_KICKED':
		case 'PLAYER_WARNED':
		case 'POSSESSED_ADMIN_CAMERA':
		case 'UNPOSSESSED_ADMIN_CAMERA':
		case 'CHAT_MESSAGE': {
			const player = SM.PlayerIds.find(state.players, p => p.ids, event.playerIds)
			if (!player) {
				console.warn(
					`Player ${
						SM.PlayerIds.prettyPrint(event.playerIds)
					} was involved in ${event.type} but was not found in the interpolated player list`,
				)
				return
			}
			return {
				...event,
				player: Obj.deepClone(player),
			}
		}
	}
}
