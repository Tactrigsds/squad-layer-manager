import type * as SchemaModels from '$root/drizzle/schema.models'
import * as Arr from '@/lib/array'
import { assertNever } from '@/lib/type-guards'
import * as SM from '@/models/squad.models'
import { z } from 'zod'

export type PlayerRef = string

export type Channel = SM.ChatChannelType

export type SyncedEvent = {
	// for the client this means that we're up-to-date with the server and we can start displaying the events
	type: 'SYNCED'
	time: Date
	matchId: number
}

export type InterpolableState = {
	players: SM.Player[]
	squads: SM.Squad[]
}
export namespace InterpolableState {
	export function clone(state: InterpolableState): InterpolableState {
		return {
			players: [...state.players],
			squads: [...state.squads],
		}
	}
}

// event enriched with relevant data
export type EventEnriched = NonNullable<ReturnType<typeof interpolateEvent>>
export type Event = SM.Events.Event

{
	// type assertions
	const _: Event['type'] = null! satisfies SchemaModels.ServerEventType
	const _1: SchemaModels.ServerEventType = null! satisfies Event['type']
}

export type ChatState = {
	rawEventBuffer: Event[]
	interpolatedState: InterpolableState
	eventBuffer: EventEnriched[]
	savepoints: Savepoint[]
	synced: boolean
}

const MIN_SAVEPOINT_INTERVAL = 5000
const NUM_SAVEPOINTS = 3

// events that are out-of-sync by more this may cause an error to be thrown.
const MAX_OUT_OF_ORDER_TIMESPAN_MS = MIN_SAVEPOINT_INTERVAL * NUM_SAVEPOINTS

export type Savepoint = {
	// the index in the iterpolated event buffer
	savedAtEventId: bigint
	state: InterpolableState
}

export const INITIAL_CHAT_STATE: ChatState = {
	rawEventBuffer: [],
	interpolatedState: {
		players: [],
		squads: [],
	},
	savepoints: [],
	eventBuffer: [],
	// indicates where this chat is now up-to-date with all events
	synced: false,
}

export function handleEvent(state: ChatState, event: Event | SyncedEvent, devMode = false) {
	if (event.type === 'SYNCED') {
		state.synced = true
		return
	}

	let mutatedIndex: number | null = null
	for (let i = state.rawEventBuffer.length - 1; i >= 0; i--) {
		const current = state.rawEventBuffer[i]
		if (current.time <= event.time) {
			mutatedIndex = i + 1
			break
		}
	}
	if (mutatedIndex === null && state.eventBuffer.length === 0) mutatedIndex = 0

	if (devMode && MAX_OUT_OF_ORDER_TIMESPAN_MS) {
		throw new Error('Max out-of-order timespan exceeded for ' + event.id)
	}
	if (mutatedIndex === null) {
		throw new Error(`Event ${event.id} is to far out-of-order to be reconciled`)
	}
	if (event.type === 'RESET' || event.type === 'NEW_GAME') {
		state.savepoints.push({ savedAtEventId: event.id, state: event.state })
	}
	state.rawEventBuffer.splice(mutatedIndex, 0, event)
	if (mutatedIndex < state.rawEventBuffer.length && state.rawEventBuffer.length > 0) {
		// we need to re-interpolate from the last savepoint because we received an out-of-order event.

		// first, let's find the savepoitn we'll be using
		let savepoint: Savepoint | undefined
		let savepointEventIndex = -1
		for (let i = mutatedIndex; i >= 0; i--) {
			const event = state.rawEventBuffer[i]
			savepoint = state.savepoints.find(s => s.savedAtEventId === event.id)
			savepointEventIndex = i
			if (savepoint) {
				break
			}
		}

		if (!savepoint) {
			throw new Error('No savepoint found!')
		}

		// reset the interpolated event buffer to the savepoint
		{
			const interpedSavepointEventIndex = state.eventBuffer.findIndex(e => e.id === state.rawEventBuffer[savepointEventIndex].id)
			state.eventBuffer = state.eventBuffer.slice(0, interpedSavepointEventIndex)
		}

		// reset the interpolated state
		if (
			// this is a slight optimization we can make since the event will set the state correctly anyway in interpolateEvent
			['RESET', 'NEW_GAME'].includes(state.rawEventBuffer[savepointEventIndex].type)
		) {
			state.interpolatedState = { players: [], squads: [] }
		} else {
			state.interpolatedState = InterpolableState.clone(savepoint.state)
		}

		for (const event of state.rawEventBuffer.slice(savepointEventIndex)) {
			const interpolated = interpolateEvent(state.interpolatedState, event)
			state.eventBuffer.push(interpolated)
			checkForSavepoint(state, event)
		}

		const numInterpolated = state.eventBuffer.length - savepointEventIndex
		const latestEvent = state.rawEventBuffer[state.rawEventBuffer.length - 1]
		truncateRawEventBuffer(state)
		return {
			code: 'ok:rollback' as const,
			interpolated: state.eventBuffer.slice(savepointEventIndex),
			message: `Rollback: re-interpolated ${numInterpolated} events (slice ${savepoint.savedAtEventId}:${latestEvent.id})`,
		}
	} else {
		// just append the event
		const interpolated = interpolateEvent(state.interpolatedState, event)
		state.eventBuffer.push(interpolated)
		checkForSavepoint(state, event)
		truncateRawEventBuffer(state)
		return { code: 'ok:appended' as const, interpolated: [interpolated] }
	}
}

/**
 * Apply state changes from events, output enriched versions of the event
 */
export function interpolateEvent(state: InterpolableState, event: Event) {
	// NOTE: mutating collections is fine, but avoid mutating entities.
	switch (event.type) {
		case 'RESET': {
			const { state: resetState, ...rest } = event
			Object.assign(state, InterpolableState.clone(resetState))
			return rest
		}

		case 'NEW_GAME': {
			const { state: initialState, ...rest } = event
			Object.assign(state, InterpolableState.clone(initialState))
			if (['change-detection', 'log-event'].includes(rest.source)) return noop('dont show synthetic NEW_GAME')
			return rest
		}

		case 'ROUND_ENDED':
			return { ...event }

		case 'PLAYER_CONNECTED': {
			if (SM.PlayerIds.find(state.players, p => p.ids, event.player.ids)) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player.ids)} connected but was already in the player list`)
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
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.playerIds)} disconnected but was not found in the player list`)
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
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.playerIds)} disconnected but was not found in the player list`)
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
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.playerIds)} joined squad but was not found in the player list`)
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
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.playerIds)} joined squad but was not found in the player list`)
			}

			const player = state.players[index]
			const squad = state.squads.find(s => SM.Squads.idsEqual(s, event))
			if (!squad) {
				return noop(`Squad ${SM.Squads.printKey(event)} not found`)
			}

			if (SM.Squads.idsEqual(player, squad)) {
				return noop(
					`Player ${SM.PlayerIds.prettyPrint(event.playerIds)} joined squad but was already in it ${
						SM.PlayerIds.match(player.ids, squad.creatorIds) ? '(is creator)' : ''
					}`,
				)
			}

			const updatedPlayer: SM.Player = {
				...player,
				squadId: event.squadId,
				isLeader: false,
			}
			state.players.splice(index, 1, updatedPlayer)
			return {
				...event,
				player: updatedPlayer,
				squad,
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
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.newLeaderIds)} promoted to leader but was not found in the player list`)
			}

			return {
				...event,
				player: state.players[newLeaderIdx],
			}
		}

		case 'SQUAD_DISBANDED': {
			const squadIndex = state.squads.findIndex(s => SM.Squads.idsEqual(s, event))
			if (squadIndex === -1) {
				return noop(`Squad ${event.squadId} disbanded but was not found in the squad list`)
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
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.playerIds)} left squad but was not found in the player list`)
			}

			const player = state.players[index]
			const squad = state.squads.find(s => SM.Squads.idsEqual(s, player))
			if (!squad) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.playerIds)} left squad but was not found in the squad list`)
			}
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
				squad: squad,
			}
		}

		case 'SQUAD_CREATED': {
			const existingSquad = state.squads.find(s => SM.Squads.idsEqual(s, event))
			if (existingSquad) {
				return noop(`Squad ${SM.Squads.printKey(event)} already exists`)
			}
			const creatorIndex = SM.PlayerIds.indexOf(state.players, p => p.ids, event.creatorIds)
			if (creatorIndex === -1) {
				return noop(
					`Squad ${SM.Squads.printKey(event)} "${event.squadName}" created by unknown player ${SM.PlayerIds.prettyPrint(event.creatorIds)}`,
				)
			}
			const creator = state.players[creatorIndex]
			if (creator.teamId !== creator.teamId) {
				return noop(
					`Creator ${SM.PlayerIds.prettyPrint(creator.ids)} is not in the same team as the squad they created ${SM.Squads.printKey(event)}`,
				)
			}
			const squad: SM.Squad = {
				creatorIds: event.creatorIds,
				locked: false,
				squadName: event.squadName,
				teamId: event.teamId,
				squadId: event.squadId,
			}
			state.squads.push(squad)
			const updatedCreator: SM.Player = {
				...creator,
				isLeader: true,
				squadId: event.squadId,
			}
			state.players[creatorIndex] = updatedCreator

			return {
				...event,
				creator: updatedCreator,
				squad,
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
				return noop(
					`Player ${
						SM.PlayerIds.prettyPrint(event.playerIds)
					} was involved in ${event.type} but was not found in the interpolated player list`,
				)
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
				return noop(
					`Player ${SM.PlayerIds.prettyPrint(event.from)} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			return {
				...event,
				player: player,
			} as SM.Events.AdminBroadcast & { player: SM.Player }
		}

		default:
			assertNever(event)
	}
	function noop(reason: string) {
		return {
			type: 'NOOP' as const,
			reason,
			id: event.id,
			time: event.time,
			matchId: event.matchId,
			originalEvent: event,
		}
	}
}

/**
 * Write a new savepoint if we need to
 */
function checkForSavepoint(state: Pick<ChatState, 'savepoints' | 'rawEventBuffer' | 'interpolatedState'>, event: Event) {
	const { interpolatedState, rawEventBuffer, savepoints } = state
	if (!event) return
	let toAdd: Savepoint | undefined
	if (event.type === 'NEW_GAME' || event.type === 'RESET') {
		// should have already been pushed
		return
	} else {
		const lastSavepoint = savepoints[savepoints.length - 1]
		const lastSaveEvent = lastSavepoint && Arr.revFind(rawEventBuffer, e => e.id === lastSavepoint.savedAtEventId)
		if (!lastSaveEvent) return
		// if it's been more than MIN_SAVEPOINT_INTERVAL milliseconds since the last savepoint, then write a new savepoint
		if ((event.time.getTime() - lastSaveEvent.time.getTime()) >= MIN_SAVEPOINT_INTERVAL) {
			toAdd = {
				savedAtEventId: event.id,
				state: InterpolableState.clone(interpolatedState),
			}
		}
	}

	if (!toAdd) return
	savepoints.push(toAdd)
}

function truncateRawEventBuffer(state: ChatState) {
	if (state.savepoints.length <= NUM_SAVEPOINTS) return
	state.savepoints.shift()
	const earliestEventIndex = state.rawEventBuffer.findIndex(e => e.id === state.savepoints[0].savedAtEventId)
	state.rawEventBuffer = state.rawEventBuffer.slice(earliestEventIndex)
}

export const EVENT_FILTER_STATE = z.enum(['ALL', 'CHAT', 'ADMIN'])
export type EventFilterState = z.infer<typeof EVENT_FILTER_STATE>
