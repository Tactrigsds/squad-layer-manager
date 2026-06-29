import * as Arr from '@/lib/array'
import * as Gen from '@/lib/generator'
import { assertNever } from '@/lib/type-guards'
import * as CS from '@/models/context-shared'
import { applyEventTeamMutations } from '@/models/pending-events.models'
import * as SE from '@/models/server-events.models'
import * as SM from '@/models/squad.models'
import { baseLogger } from '@/systems/logger.client'
import { z } from 'zod'

export type PlayerRef = string

export type Channel = SM.ChatChannelType

export type SyncedEvent = {
	// for the client this means that we're up-to-date with the server and we can start displaying the events
	type: 'SYNCED'
	time: number
	matchId: number
}

// tells client that we should reset the state
export type InitEvent = {
	type: 'INIT'
	time: number
	serverId: string
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

export type LifecycleEvent = SyncedEvent | ConnectionErrorEvent | ReconnectedEvent | InitEvent

export type InterpolableState = {
	players: SM.Player[]
	squads: SM.UniqueSquad[]
}

export namespace InterpolableState {
	export function clone(state: InterpolableState): InterpolableState {
		return {
			players: state.players.map(p => ({ ...p, ids: { ...p.ids } })),
			squads: [...state.squads],
		}
	}
}

export type Event = SE.Event

// event enriched with relevant data
export type EventEnriched =
	| NoopEvent
	| SE.MapSet
	| SE.NewGame
	| SE.Reset
	| SE.RconConnected
	| SE.RconDisconnected
	| SE.RoundEnded
	| SE.PlayerConnected<SM.Player>
	| (SE.PlayerDisconnected<SM.Player>)
	| (SE.PlayerDetailsChanged<SM.Player>)
	| (SE.SquadDetailsChanged & { squad: SM.UniqueSquad; prevDetails: SE.SquadDetailsChanged['details'] })
	| (SE.SquadRenamed & { squad: SM.UniqueSquad })
	| (SE.PlayerChangedTeam<SM.Player> & { prevTeamId: SM.TeamId | null })
	| (SE.PlayerJoinedSquad<SM.Player> & { squad: SM.UniqueSquad })
	| (SE.PlayerPromotedToLeader<SM.Player> & { squad: SM.UniqueSquad })
	| SE.TeamsPolledUpdate
	| (SE.SquadDisbanded & { squad: SM.UniqueSquad })
	| (SE.PlayerLeftSquad<SM.Player> & { wasLeader: boolean; squad: SM.UniqueSquad })
	| (SE.SquadCreated & { creator: SM.Player; squad: SM.UniqueSquad })
	| SE.PlayerWarned<SM.Player>
	| SE.PlayerBanned<SM.Player>
	| SE.PlayerKicked<SM.Player>
	| SE.PossessedAdminCamera<SM.Player>
	| SE.UnpossessedAdminCamera<SM.Player>
	| SE.ChatMessage<SM.Player>
	| (SE.AdminBroadcast & { player?: SM.Player })
	| SE.PlayerDied<SM.Player>
	| SE.PlayerWounded<SM.Player>

export type NoopEvent = {
	type: 'NOOP'
	reason: string
	id: number
	time: number
	matchId: number
	originalEvent: Event
}

export type ChatState = {
	eventBuffer: EventEnriched[]

	// the state of the chat as of the last event
	interpolatedState: InterpolableState

	connectionError: ConnectionErrorEvent | null

	synced: boolean
}

export function getInitialInterpolatedState(): InterpolableState {
	return {
		players: [],
		squads: [],
	}
}

export function getInitialChatState(): ChatState {
	return {
		interpolatedState: getInitialInterpolatedState(),
		eventBuffer: [],
		synced: false,
		connectionError: null,
	}
}

const chatLog: CS.Log = { ...CS.init(), log: baseLogger.child({ name: 'chat' }) }

export function handleEvent(
	state: ChatState,
	event: Event | LifecycleEvent,
	opts?: InterpolationOptions,
) {
	if (event.type === 'INIT') {
		Object.assign(state, getInitialChatState())
		return
	}
	if (event.type === 'SYNCED') {
		state.synced = true
		return
	}
	if (event.type === 'CONNECTION_ERROR') {
		state.connectionError = event
		return
	}
	if (event.type === 'CHAT_RECONNECTED') {
		state.connectionError = null
		const lastEvent = state.eventBuffer[state.eventBuffer.length - 1]
		if (!lastEvent || event.resumedEventId === lastEvent.id) {
			state.synced = false
			return
		}
		if (event.resumedEventId !== null) {
			throw new Error(`resumed from the wrong event id!`)
		}
		Object.assign(state, getInitialChatState())
		return
	}

	const enriched = interpolateEvent(state.interpolatedState, event, opts)
	state.eventBuffer.push(enriched)
}

const compiledPatternMap = new WeakMap<string[], RegExp[]>()

const SuppressionSchema = z.string().refine((s) => new RegExp(s))

export const ChatConfigSchema = z.object({
	warnSuppressionPatterns: z.array(SuppressionSchema).prefault([]).describe('Regex patterns to suppress warning messages'),
	broadcastSuppressionPatterns: z.array(SuppressionSchema).prefault([]).describe(
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

function interpolateEvent(
	state: InterpolableState,
	event: Event,
	opts?: InterpolationOptions,
): EventEnriched {
	switch (event.type) {
		case 'MAP_SET':
		case 'NEW_GAME':
		case 'RESET': {
			applyEventTeamMutations(chatLog, state, event)
			return event
		}

		case 'RCON_CONNECTED':
		case 'RCON_DISCONNECTED':
		case 'ROUND_ENDED':
		case 'TEAMS_POLLED_UPDATE':
			return { ...event }

		case 'PLAYER_CONNECTED': {
			if (SM.PlayerIds.find(state.players, p => p.ids, event.player.ids)) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player.ids)} connected but was already in the player list`)
			}
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player: event.player }
		}

		case 'PLAYER_DISCONNECTED': {
			const index = SM.PlayerIds.indexOf(state.players, p => p.ids, event.player)
			if (index === -1) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player)} disconnected but was not found in the player list`)
			}
			const player = state.players[index]
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player }
		}

		case 'PLAYER_DETAILS_CHANGED': {
			const index = SM.PlayerIds.indexOf(state.players, p => p.ids, event.player)
			if (index === -1) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player)} had details changed but was not found in the player list`)
			}
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player: state.players[index] }
		}

		case 'SQUAD_DETAILS_CHANGED': {
			const index = state.squads.findIndex(s => s.uniqueId === event.uniqueId)
			if (index === -1) {
				return noop(`Squad ${event.uniqueId} had details changed but was not found in the squad list`)
			}
			const prevDetails: SE.SquadDetailsChanged['details'] = { locked: state.squads[index].locked }
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, squad: state.squads[index], prevDetails }
		}

		case 'SQUAD_RENAMED': {
			const index = state.squads.findIndex(s => s.uniqueId === event.uniqueId)
			if (index === -1) {
				return noop(`Squad ${event.uniqueId} was renamed but was not found in the squad list`)
			}
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, squad: state.squads[index] }
		}

		case 'PLAYER_CHANGED_TEAM': {
			const index = SM.PlayerIds.indexOf(state.players, p => p.ids, event.player)
			if (index === -1) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player)} joined squad but was not found in the player list`)
			}
			const prevTeamId = state.players[index].teamId
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player: state.players[index], prevTeamId }
		}

		case 'PLAYER_JOINED_SQUAD': {
			const index = SM.PlayerIds.indexOf(state.players, p => p.ids, event.player)
			if (index === -1) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player)} joined squad but was not found in the player list`)
			}
			const squad = state.squads.find(s => s.uniqueId === event.uniqueId)
			if (!squad) {
				return noop(`Squad ${event.uniqueId} not found`)
			}
			if (SM.Squads.idsEqual(state.players[index], squad)) {
				return noop(
					`Player ${SM.PlayerIds.prettyPrint(event.player)} joined squad but was already in it ${
						SM.PlayerIds.match(state.players[index].ids, squad.creator) ? '(is creator)' : ''
					}`,
				)
			}
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player: state.players[index], squad }
		}

		case 'PLAYER_PROMOTED_TO_LEADER': {
			const squad = state.squads.find(s => s.uniqueId === event.uniqueId)
			if (!squad) {
				return noop(`Squad ${event.uniqueId} not found for PLAYER_PROMOTED_TO_LEADER`)
			}
			let newLeaderIdx = -1
			for (let i = 0; i < state.players.length; i++) {
				const player = state.players[i]
				if (player.squadId !== squad.squadId || player.teamId !== squad.teamId) continue
				if (SM.PlayerIds.match(player.ids, event.player)) {
					newLeaderIdx = i
					break
				}
			}
			if (newLeaderIdx === -1) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player)} promoted to leader but was not found in the player list`)
			}
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player: state.players[newLeaderIdx], squad }
		}

		case 'SQUAD_DISBANDED': {
			const squadIndex = state.squads.findIndex(s => s.uniqueId === event.uniqueId)
			if (squadIndex === -1) {
				return noop(`Squad ${event.uniqueId} disbanded but was not found in the squad list`)
			}
			const squad = state.squads[squadIndex]
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, squad }
		}

		case 'PLAYER_LEFT_SQUAD': {
			const index = SM.PlayerIds.indexOf(state.players, p => p.ids, event.player)
			if (index === -1) {
				return noop(`Player ${SM.PlayerIds.prettyPrint(event.player)} left squad but was not found in the player list`)
			}
			const wasLeader = state.players[index].isLeader
			const squad = state.squads.find(s => s.uniqueId === event.uniqueId)
			if (!squad) {
				return noop(`Squad ${event.uniqueId} not found for PLAYER_LEFT_SQUAD`)
			}
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, player: state.players[index], wasLeader, squad }
		}

		case 'SQUAD_CREATED': {
			const existingSquad = state.squads.find(s => s.uniqueId === event.squad.uniqueId)
			if (existingSquad) {
				return noop(`Squad ${event.squad.uniqueId} already exists`)
			}
			const squad: SM.UniqueSquad = event.squad
			const creatorIndex = SM.PlayerIds.indexOf(state.players, p => p.ids, event.squad.creator)
			if (creatorIndex === -1) {
				return noop(
					`Squad ${SM.Squads.printKey(squad)} "${event.squad.squadName}" created by unknown player ${
						SM.PlayerIds.prettyPrint(squad.creator)
					}`,
				)
			}
			if (state.players[creatorIndex].teamId !== squad.teamId) {
				return noop(
					`Creator ${SM.PlayerIds.prettyPrint(state.players[creatorIndex].ids)} is not in the same team as the squad they created ${
						SM.Squads.printKey(squad)
					}`,
				)
			}
			applyEventTeamMutations(chatLog, state, event)
			return { ...event, creator: state.players[creatorIndex] }
		}

		case 'PLAYER_WARNED': {
			if (testPatterns(opts?.warnSuppressionPatterns ?? [], event.reason)) {
				return noop(`Warn reason ${event.reason} matches warn suppression pattern`)
			}
			const player = SM.PlayerIds.find(state.players, p => p.ids, event.player)
			if (!player) {
				return noop(
					`Player ${
						SM.PlayerIds.prettyPrint(event.player)
					} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			return { ...event, player }
		}

		case 'PLAYER_BANNED':
		case 'PLAYER_KICKED':
		case 'POSSESSED_ADMIN_CAMERA':
		case 'UNPOSSESSED_ADMIN_CAMERA': {
			const player = SM.PlayerIds.find(state.players, p => p.ids, event.player)
			if (!player) {
				return noop(
					`Player ${
						SM.PlayerIds.prettyPrint(event.player)
					} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			if (event.type === 'PLAYER_KICKED') {
				return { ...event, player, reason: event.reason?.replace('Kicked from the server: ', '').trim() }
			}
			return { ...event, player }
		}

		case 'CHAT_MESSAGE': {
			const player = SM.PlayerIds.find(state.players, p => p.ids, event.player)
			if (!player) {
				return noop(
					`Player ${
						SM.PlayerIds.prettyPrint(event.player)
					} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			return { ...event, player }
		}

		case 'ADMIN_BROADCAST': {
			if (event.from) {
				if (event.from === 'RCON' || event.from === 'unknown') {
					if (testPatterns(opts?.broadcastSuppressionPatterns ?? [], event.message)) {
						return noop(`Broadcast message ${event.message} matches broadcast suppression pattern`)
					}
					return { ...event, player: undefined } as SE.AdminBroadcast & { player: undefined }
				}
				const player = SM.PlayerIds.find(state.players, p => p.ids, event.from)
				if (!player) {
					return noop(
						`Player ${
							SM.PlayerIds.prettyPrint(event.from)
						} was involved in ${event.type} but was not found in the interpolated player list`,
					)
				}
				return { ...event, player } as SE.AdminBroadcast & { player: SM.Player }
			} else if (event.source) {
				if (event.source.type === 'player') {
					const player = SM.PlayerIds.find(state.players, p => p.ids, event.source.playerIds)
					if (!player) {
						return noop(
							`Player ${
								SM.PlayerIds.prettyPrint(event.source)
							} was involved in ${event.type} but was not found in the interpolated player list`,
						)
					}
					return { ...event, player } as SE.AdminBroadcast & { player: SM.Player }
				} else if (event.source.type === 'rcon') {
					return { ...event } as SE.AdminBroadcast
				} else {
					assertNever(event.source)
				}
			} else {
				throw new Error(`AdminBroadcast event must have either from or source property`)
			}
		}

		case 'PLAYER_DIED':
		case 'PLAYER_WOUNDED': {
			const victim = SM.PlayerIds.find(state.players, p => p.ids, event.victim)
			if (!victim) {
				return noop(
					`Victim ${
						SM.PlayerIds.prettyPrint(event.victim)
					} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			const attacker = SM.PlayerIds.find(state.players, p => p.ids, event.attacker)
			if (!attacker) {
				return noop(
					`Attacker ${
						SM.PlayerIds.prettyPrint(event.attacker)
					} was involved in ${event.type} but was not found in the interpolated player list`,
				)
			}
			return { ...event, victim, attacker }
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

export type PrimaryFilterState = null | {
	type: 'player'
	id: SM.PlayerId
} | {
	type: 'squad'
	id: number
}

export const SECONDARY_FILTER_STATE = z.enum(['ALL', 'DEFAULT', 'CHAT', 'ADMIN'])
export type SecondaryFilterState = z.infer<typeof SECONDARY_FILTER_STATE>

export type ChatViewOptionsStore = {
	primaryFilter: PrimaryFilterState
	setPrimaryFilter(primary: PrimaryFilterState): void
	secondaryFilter: SecondaryFilterState
	setSecondaryFilter(secondary: SecondaryFilterState): void
}

export function isEventFilteredBySecondary(event: EventEnriched, filterState: SecondaryFilterState): boolean {
	// Always show new game and round ended events
	if (
		['NEW_GAME', 'ROUND_ENDED', 'RESET', 'RCON_CONNECTED', 'RCON_DISCONNECTED'].includes(event.type)
	) {
		return false
	}

	if (filterState === 'ALL') {
		return false
	} else if (filterState === 'DEFAULT') {
		if (event.type === 'PLAYER_DIED' || event.type === 'PLAYER_WOUNDED' && event.variant !== 'teamkill') {
			return true
		}
		if (event.type === 'PLAYER_JOINED_SQUAD' || event.type === 'PLAYER_LEFT_SQUAD') {
			return true
		}
		return false
	} else if (filterState === 'CHAT') {
		// Show only chat messages and broadcasts
		return !(event.type === 'CHAT_MESSAGE' || event.type === 'ADMIN_BROADCAST' && event.from !== 'RCON')
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

export function* iterAssocPlayers(event: EventEnriched, playerId?: SM.PlayerId) {
	if (event.type === 'NOOP') return
	if (!event) {
		yield* SE.iterAssocPlayers(event)
		return
	}
	for (const [player, assocType] of SE.iterAssocPlayers(event)) {
		if (typeof player === 'string' && player === playerId) yield [player, assocType] as const
		if (typeof player === 'object' && SM.PlayerIds.getPlayerId(player.ids) === playerId) yield [player, assocType] as const
	}
}

export function hasAssocPlayer(event: EventEnriched, playerId: SM.PlayerId): boolean {
	return Gen.hasValues(iterAssocPlayers(event, playerId))
}

export function findLastPlayerInstance(events: EventEnriched[], playerId: SM.PlayerId): SM.Player | undefined {
	for (const event of Arr.revIter(events)) {
		for (const [player] of iterAssocPlayers(event, playerId)) {
			if (typeof player === 'object') return player
		}
	}
}

export function getPlayerRelatedEvents(events: EventEnriched[], playerId: SM.PlayerId): EventEnriched[] {
	return events.filter(event => hasAssocPlayer(event, playerId))
}
