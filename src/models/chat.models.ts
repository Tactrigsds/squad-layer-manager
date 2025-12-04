import { assertNever } from '@/lib/type-guards'
import * as SM from '@/models/squad.models'
import { z } from 'zod'

export type PlayerRef = string

export type Channel = SM.ChatChannelType

export type SyncedEvent = {
	// for the client this means that we're up-to-date with the server and we can start displaying the events
	type: 'SYNCED'
	time: number
	matchId: number
}

export type ConnectionErrorCode = 'CONNECTION_LOST' | 'RECONNECT_FAILED'
export type ConnectionErrorEvent = {
	type: 'CONNECTION_ERROR'
	code: ConnectionErrorCode
	time: number
}

export type ReconnectedEvent = {
	type: 'CHAT_RECONNECTED'
	resumedEventId: null | number
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

export type Event = SM.Events.Event

export type DedupedBase = {
	eventCount: number
}

// event enriched with relevant data
export type EventEnriched =
	| NoopEvent
	| Omit<SM.Events.NewGame, 'state'>
	| Omit<SM.Events.Reset, 'state'>
	| SM.Events.RoundEnded
	| (SM.Events.PlayerConnected & { player: SM.Player })
	| (SM.Events.PlayerDisconnected & { player: SM.Player })
	| (SM.Events.PlayerDetailsChanged & { player: SM.Player })
	| (SM.Events.PlayerChangedTeam & { player: SM.Player; prevTeamId: SM.TeamId | null })
	| (SM.Events.PlayerJoinedSquad & { player: SM.Player; squad: SM.Squad })
	| (SM.Events.PlayerPromotedToLeader & { player: SM.Player })
	| (SM.Events.SquadDisbanded & { squad: SM.Squad })
	| (SM.Events.PlayerLeftSquad & { player: SM.Player; wasLeader: boolean; squad: SM.Squad })
	| { type: 'PLAYER_LEFT_SQUAD_DEDUPED'; players: (SM.Player & { wasLeader: boolean })[]; squad: SM.Squad } & SM.Events.Base
	| (SM.Events.SquadCreated & { creator: SM.Player; squad: SM.Squad })
	| (SM.Events.PlayerWarned & { player: SM.Player })
	| { type: 'PLAYER_WARNED_DEDUPED'; players: (SM.Player & { times: number })[]; reason: string } & SM.Events.Base
	| (SM.Events.PlayerBanned & { player: SM.Player })
	| (SM.Events.PlayerKicked & { player: SM.Player })
	| (SM.Events.PossessedAdminCamera & { player: SM.Player })
	| (SM.Events.UnpossessedAdminCamera & { player: SM.Player })
	| (SM.Events.ChatMessage & { player: SM.Player })
	| (SM.Events.AdminBroadcast & { player: SM.Player | undefined })
	| (SM.Events.PlayerDied & { victim: SM.Player; attacker: SM.Player })
	| (SM.Events.PlayerWounded & { victim: SM.Player; attacker: SM.Player })

export type NoopEvent = {
	type: 'NOOP'
	reason: string
	id: number
	time: number
	matchId: number
	originalEvent: Event
}

export type ChatState = {
	rawEventBuffer: Event[]

	eventBuffer: EventEnriched[]

	// the state of the chat as of the last event
	interpolatedState: InterpolableState

	connectionError?: ConnectionErrorEvent

	// snapshots we can revert to in case of an out-of-order event
	savepoints: Savepoint[]
	synced: boolean
}

const NUMBER_OF_SAVEPOINTS = 3
const SAVEPOINT_INTERVAL = 100

export type Savepoint = {
	// the index in the iterpolated event buffer
	savedAtEventId: number
	state: InterpolableState
}

export function getInitialInterpolatedState(): InterpolableState {
	return {
		players: [],
		squads: [],
	}
}

export function getInitialChatState(): ChatState {
	return {
		rawEventBuffer: [],
		interpolatedState: getInitialInterpolatedState(),
		savepoints: [],
		eventBuffer: [],
		// indicates when this chat is now caught up on initial events from the server
		synced: false,
	}
}

/**
 * Process events into ChatState, with roll-back behavior in the case of out-of-order events
 * Given a stream of events this lets us annot
 */
export function handleEvent(
	state: ChatState,
	event: Event | SyncedEvent | ConnectionErrorEvent | ReconnectedEvent,
	opts?: InterpolationOptions,
) {
	if (event.type === 'SYNCED') {
		state.synced = true
		return
	}
	if (event.type === 'CONNECTION_ERROR') {
		state.connectionError = event
		return
	}

	if (event.type === 'CHAT_RECONNECTED') {
		delete state.connectionError
		const lastEvent = state.eventBuffer[state.eventBuffer.length - 1]
		if (!lastEvent || event.resumedEventId === lastEvent.id) {
			// we're good to go, should be receiving events soon
			state.synced = false
			return
		}
		if (event.resumedEventId !== null) {
			throw new Error(`resumed from the wrong event id!`)
		}

		// we're out of sync and we need to reset the state
		Object.assign(state, getInitialChatState())
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
	if (mutatedIndex === null && state.rawEventBuffer.length >= SAVEPOINT_INTERVAL) {
		throw new Error(`Event ${event.id} is too far out-of-order to be reconciled`)
	}

	mutatedIndex ??= 0

	// remove all savepoints at or after the mutated index
	for (let i = mutatedIndex; i < state.rawEventBuffer.length; i++) {
		const event = state.rawEventBuffer[i]
		const savepointIndex = state.savepoints.findIndex(s => s.savedAtEventId === event.id)
		if (savepointIndex !== -1) {
			state.savepoints = state.savepoints.slice(0, savepointIndex)
			break
		}
	}
	let lastSaveEventIndex = -1
	if (state.savepoints.length > 0) {
		lastSaveEventIndex = state.rawEventBuffer.findIndex(e => e.id === state.savepoints[state.savepoints.length - 1].savedAtEventId)
	}
	const eventsToProcess: Event[] = []
	if (mutatedIndex < state.rawEventBuffer.length) {
		eventsToProcess.push(...state.rawEventBuffer.slice(lastSaveEventIndex + 1, mutatedIndex))
		eventsToProcess.push(event)
		eventsToProcess.push(...state.rawEventBuffer.slice(mutatedIndex + 1))
		state.rawEventBuffer = state.rawEventBuffer.slice(0, lastSaveEventIndex + 1)
		state.eventBuffer = state.eventBuffer.slice(0, lastSaveEventIndex + 1)
		let savepoint = state.savepoints[state.savepoints.length - 1]
		if (!savepoint) {
			state.interpolatedState = getInitialInterpolatedState()
		} else {
			state.interpolatedState = InterpolableState.clone(savepoint.state)
		}
	} else {
		eventsToProcess.push(event)
	}

	for (const event of eventsToProcess) {
		state.rawEventBuffer.push(event)
		// we may also modify eventBuffer in place
		const interpolated = interpolateEvent(state.interpolatedState, state.eventBuffer, event, opts)
		state.eventBuffer.push(interpolated)
	}

	if (SAVEPOINT_INTERVAL < state.rawEventBuffer.length - lastSaveEventIndex) {
		state.savepoints.push({ savedAtEventId: event.id, state: InterpolableState.clone(state.interpolatedState) })

		if (state.savepoints.length <= NUMBER_OF_SAVEPOINTS) return
		const newFirstSavepointIndex = state.savepoints.length - NUMBER_OF_SAVEPOINTS
		const newFirstEventIndex = state.rawEventBuffer.findIndex(e => e.id === state.savepoints[newFirstSavepointIndex].savedAtEventId)
		if (newFirstEventIndex === -1) {
			throw new Error(`Could not find event ${state.savepoints[newFirstSavepointIndex].savedAtEventId} for savepoint`)
		}
		state.rawEventBuffer = state.rawEventBuffer.slice(newFirstEventIndex)
		state.savepoints = state.savepoints.slice(newFirstSavepointIndex)

		// keep all matches up to and including the first "stable" new game
		let keptMatchIds = new Set<number>()
		for (let i = state.eventBuffer.length - 1; i >= 0; i--) {
			const event = state.eventBuffer[i]
			if (event.type === 'NEW_GAME') {
				keptMatchIds.add(event.matchId)
				if (newFirstEventIndex > i) break
			}
		}
		state.eventBuffer = state.eventBuffer.filter(e => keptMatchIds.has(e.matchId))
	}
}

const compiledPatternMap = new WeakMap<string[], RegExp[]>()

const SuppressionSchema = z.string().refine(s => new RegExp(s))

export const ChatConfigSchema = z.object({
	warnSuppressionPatterns: z.array(SuppressionSchema).default([]).describe('Regex patterns to suppress warning messages'),
	broadcastSuppressionPatterns: z.array(SuppressionSchema).default([]).describe(
		'Regex patterns to suppress broadcast messages. these will not apply to broadcasts sent via an ingame command.',
	),
})

function testPatterns(patterns: string[], text: string): boolean {
	if (patterns.length === 0) return false
	let compiled = compiledPatternMap.get(patterns)
	if (!compiled) {
		compiled = patterns.map(p => new RegExp(p))
		compiledPatternMap.set(patterns, compiled)
	}
	return compiled.some(pattern => pattern.test(text))
}

type InterpolationOptions = {
	warnSuppressionPatterns?: string[]
	broadcastSuppressionPatterns?: string[]
}

/**
 * Apply state changes from events, output enriched versions of the event
 */
export function interpolateEvent(
	state: InterpolableState,
	eventBuffer: EventEnriched[],
	event: Event,
	opts?: InterpolationOptions,
): EventEnriched {
	// NOTE: mutating collections is fine, but avoid mutating entities.
	switch (event.type) {
		case 'NEW_GAME':
		case 'RESET': {
			const { state: newState, ...rest } = event
			Object.assign(state, InterpolableState.clone({ ...newState }))
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
		case 'PLAYER_WARNED': {
			if (testPatterns(opts?.warnSuppressionPatterns ?? [], event.reason)) {
				return noop(`Warn reason ${event.reason} matches warn suppression pattern`)
			}
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

		case 'PLAYER_BANNED':
		case 'PLAYER_KICKED':
		case 'POSSESSED_ADMIN_CAMERA':
		case 'UNPOSSESSED_ADMIN_CAMERA': {
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
				if (testPatterns(opts?.broadcastSuppressionPatterns ?? [], event.message)) {
					return noop(`Broadcast message ${event.message} matches broadcast suppression pattern`)
				}
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

		case 'PLAYER_DIED': {
			const victim = SM.PlayerIds.find(state.players, p => p.ids, event.victimIds)
			if (!victim) {
				return noop(
					`Victim ${
						SM.PlayerIds.prettyPrint(event.victimIds)
					} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			const attacker = SM.PlayerIds.find(state.players, p => p.ids, event.attackerIds)
			if (!attacker) {
				return noop(
					`Attacker ${
						SM.PlayerIds.prettyPrint(event.attackerIds)
					} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			return {
				...event,
				victim,
				attacker,
			}
		}

		case 'PLAYER_WOUNDED': {
			const victim = SM.PlayerIds.find(state.players, p => p.ids, event.victimIds)
			if (!victim) {
				return noop(
					`Victim ${
						SM.PlayerIds.prettyPrint(event.victimIds)
					} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			const attacker = SM.PlayerIds.find(state.players, p => p.ids, event.attackerIds)
			if (!attacker) {
				return noop(
					`Attacker ${
						SM.PlayerIds.prettyPrint(event.attackerIds)
					} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			return {
				...event,
				victim,
				attacker,
			}
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

export const EVENT_FILTER_STATE = z.enum(['ALL', 'CHAT', 'ADMIN'])
export type EventFilterState = z.infer<typeof EVENT_FILTER_STATE>

export function isEventFiltered(event: EventEnriched, filterState: EventFilterState): boolean {
	// Always show new game and round ended events
	if (event.type === 'NEW_GAME' || event.type === 'ROUND_ENDED') {
		return false
	}

	if (filterState === 'ALL') {
		return false
	} else if (filterState === 'CHAT') {
		// Show only chat messages and broadcasts
		return !(event.type === 'CHAT_MESSAGE' || event.type === 'ADMIN_BROADCAST')
	} else if (filterState === 'ADMIN') {
		// Show only admin chat messages and broadcasts
		if (event.type === 'ADMIN_BROADCAST' && event.from !== 'RCON') {
			return false
		} else if (event.type === 'CHAT_MESSAGE' && event.channel.type === 'ChatAdmin') {
			return false
		}
		return true
	}
	return false
}
