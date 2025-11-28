import type * as SchemaModels from '$root/drizzle/schema.models'

import { assertNever } from '@/lib/type-guards'
import * as SM from '@/models/squad.models'
import { z } from 'zod'

export type PlayerRef = string

export type Channel = SM.ChatChannelType

export type SyncEvent = {
	type: 'FLASH'
	state: ChatState
}

export type InterpolableState = {
	players: SM.Player[]
	squads: SM.Squad[]
}

// event enriched with relevant data
export type EventEnriched = NonNullable<ReturnType<typeof interpolateEvent>>
export type Event = SM.Events.Event | ResetEvent

{
	// type assertions
	const _: Event['type'] = null! satisfies SchemaModels.ServerEventType
	const _1: SchemaModels.ServerEventType = null! satisfies Event['type']
}

export type ResetReason = 'slm-started' | 'rcon-reconnected'
export type ResetEvent = {
	type: 'RESET'
	state: InterpolableState
	time: Date
	matchId: number
	reason: ResetReason
}

export type ChatState = {
	rawEventBuffer: Event[]

	interpolatedState: InterpolableState
	eventBuffer: EventEnriched[]
}
export const INITIAL_CHAT_STATE: ChatState = {
	rawEventBuffer: [],
	interpolatedState: {
		players: [],
		squads: [],
	},
	eventBuffer: [],
}

export function handleEvent(state: ChatState, event: Event | SyncEvent) {
	if (event.type === 'FLASH') {
		Object.assign(state, event.state)
		return
	}

	const rawBuffer = state.rawEventBuffer
	let mutatedIndex: number | null = null
	let savepointIndex: number = 0
	for (let i = rawBuffer.length - 1; i >= 0; i--) {
		const current = rawBuffer[i]
		if (mutatedIndex === null && current.time <= event.time) {
			mutatedIndex = i + 1
		}
		if (event.type === 'RESET') {
			savepointIndex = i + 1
			break
		} else if (mutatedIndex !== null && current.type === 'RESET') {
			savepointIndex = i
			break
		}
	}
	if (mutatedIndex === null) mutatedIndex = rawBuffer.length
	rawBuffer.splice(mutatedIndex, 0, event)
	if (mutatedIndex < state.eventBuffer.length) {
		// we need to re-interpolate from the last RESET because we received an out-of-order event.
		let newState: InterpolableState = { players: [], squads: [] }
		state.eventBuffer = state.eventBuffer.slice(0, savepointIndex)
		for (const event of rawBuffer.slice(savepointIndex, mutatedIndex)) {
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
export function interpolateEvent(state: InterpolableState, event: Event) {
	// NOTE: mutating collections is fine, but avoid mutating entities.
	switch (event.type) {
		case 'RESET': {
			const { state: resetState, ...rest } = event
			Object.assign(state, resetState)
			return rest
		}
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
				player: player,
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
				player: player,
			}
		}

		case 'PLAYER_DETAILS_CHANGED': {
			const index = SM.PlayerIds.indexOf(state.players, p => p.ids, event.playerIds)
			if (index === -1) {
				console.warn(`Player ${SM.PlayerIds.prettyPrint(event.playerIds)} disconnected but was not found in the player list`)
				return
			}
			const player = state.players[index]
			const updated = { ...player, ...event.details }
			state.players.splice(index, 1, updated)
			return {
				...event,
				player: updated,
			}
		}

		case 'PLAYER_CHANGED_TEAM': {
			const index = SM.PlayerIds.indexOf(state.players, p => p.ids, event.playerIds)
			if (index === -1) {
				console.warn(`Player ${SM.PlayerIds.prettyPrint(event.playerIds)} joined squad but was not found in the player list`)
				return
			}

			const player = state.players[index]
			const updatedPlayer: SM.Player = {
				...player,
				teamId: event.newTeamId,
			}
			state.players[index] = updatedPlayer
			return {
				...event,
				player: updatedPlayer,
				prevTeamId: player.teamId,
			}
		}

		case 'PLAYER_JOINED_SQUAD': {
			const index = SM.PlayerIds.indexOf(state.players, p => p.ids, event.playerIds)
			if (index === -1) {
				console.warn(`Player ${SM.PlayerIds.prettyPrint(event.playerIds)} joined squad but was not found in the player list`)
				return
			}

			const player = state.players[index]
			const updatedPlayer: SM.Player = {
				...player,
				squadId: event.squadId,
				isLeader: false,
			}
			state.players.splice(index, 1, updatedPlayer)
			return {
				...event,
				player: updatedPlayer,
			}
		}

		case 'PLAYER_PROMOTED_TO_LEADER': {
			let newLeaderIdx = -1
			for (let i = 0; i < state.players.length; i++) {
				const player = state.players[i]
				if (!SM.Squads.idsEqual(player, event)) continue
				const isNewLeader = SM.PlayerIds.match(player.ids, event.newLeaderIds)
				if (isNewLeader) {
					newLeaderIdx = i
				}
				if (!isNewLeader && !player.isLeader) continue
				const updatedPlayer: SM.Player = {
					...player,
					isLeader: isNewLeader,
				}
				state.players.splice(i, 1, updatedPlayer)
			}

			if (newLeaderIdx === -1) {
				console.warn(`Player ${SM.PlayerIds.prettyPrint(event.newLeaderIds)} promoted to leader but was not found in the player list`)
				return
			}

			return {
				...event,
				player: state.players[newLeaderIdx],
			}
		}

		case 'SQUAD_DISBANDED': {
			const squadIndex = state.squads.findIndex(s => SM.Squads.idsEqual(s, event))
			if (squadIndex === -1) {
				console.warn(`Squad ${event.squadId} disbanded but was not found in the squad list`)
				return
			}
			const [squad] = state.squads.splice(squadIndex, 1)
			return {
				...event,
				squad: squad,
			}
		}

		case 'PLAYER_LEFT_SQUAD': {
			const index = SM.PlayerIds.indexOf(state.players, p => p.ids, event.playerIds)
			if (index === -1) {
				console.warn(`Player ${SM.PlayerIds.prettyPrint(event.playerIds)} left squad but was not found in the player list`)
				return
			}

			const player = state.players[index]
			const updatedPlayer: SM.Player = {
				...player,
				squadId: null,
				isLeader: false,
			}
			state.players.splice(index, 1, updatedPlayer)
			return {
				...event,
				player: updatedPlayer,
				wasLeader: player.isLeader,
			}
		}

		case 'SQUAD_CREATED': {
			const existingSquad = state.squads.find(s => SM.Squads.idsEqual(s, event.squad))
			if (existingSquad) {
				console.warn(`Squad ${event.squad.squadId} already exists`, existingSquad)
				return
			}
			const creatorIndex = SM.PlayerIds.indexOf(state.players, p => p.ids, event.squad.creatorIds)
			if (creatorIndex === -1) {
				console.warn(`Squad ${event.squad.squadId} created by unknown player ${SM.PlayerIds.prettyPrint(event.squad.creatorIds)}`)
				return
			}
			const creator = state.players[creatorIndex]
			if (creator.teamId !== creator.teamId) {
				console.warn(
					`Creator ${SM.PlayerIds.prettyPrint(creator.ids)} is not in the same team as the squad they created ${
						SM.Squads.printKey(event.squad)
					}`,
				)
			}
			state.squads.push(event.squad)
			const updatedCreator: SM.Player = {
				...creator,
				isLeader: true,
				squadId: event.squad.squadId,
			}
			state.players.splice(creatorIndex, 1, updatedCreator)

			return {
				...event,
				creator: updatedCreator,
			}
		}

		case 'PLAYER_BANNED':
		case 'PLAYER_KICKED':
		case 'PLAYER_WARNED':
		case 'POSSESSED_ADMIN_CAMERA':
		case 'UNPOSSESSED_ADMIN_CAMERA':
		case 'CHAT_MESSAGE': {
			let player = SM.PlayerIds.find(state.players, p => p.ids, event.playerIds)
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
				player: player,
			}
		}

		case 'ADMIN_BROADCAST': {
			if (event.from === 'RCON' || event.from === 'unknown') {
				return { ...event, player: undefined } as SM.Events.AdminBroadcast & { player: undefined }
			}
			const player = SM.PlayerIds.find(state.players, p => p.ids, event.from)
			if (!player) {
				console.warn(
					`Player ${SM.PlayerIds.prettyPrint(event.from)} was involved in ${event.type} but was not found in the interpolated player list`,
				)
				return
			}
			return {
				...event,
				player: player,
			} as SM.Events.AdminBroadcast & { player: SM.Player }
		}

		default:
			assertNever(event)
	}
}

export const EVENT_FILTER_STATE = z.enum(['ALL', 'CHAT', 'ADMIN'])
export type EventFilterState = z.infer<typeof EVENT_FILTER_STATE>
