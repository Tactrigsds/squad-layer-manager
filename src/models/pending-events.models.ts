import * as Arr from '@/lib/array'
import * as Gen from '@/lib/generator'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import type * as MH from '@/models/match-history.models'
import type * as SE from '@/models/server-events.models'
import * as SM from '@/models/squad.models'
import { z } from 'zod'
type TeamsUpdateEvent = { type: 'TEAMS_UPDATE'; id: number; teams: SM.Teams; time: number }
export type Attribution = { type: 'MAP_SET_ATTRIBUTION'; itemId: string; layerId: L.LayerId; time: number }
export type State = {
	lastKnownLogEventTime: number | null
	eventBufs: {
		rconEmittedEvents: (SM.RconEvents.Event & { id: number })[]
		logEvents: (SM.LogEvents.ParsedEvent & { id: number })[]
		lifecycleEvents: (
			| (Omit<SE.RconConnected, 'matchId' | 'reconnected'> & { currentLayerId: L.LayerId; nextLayerId: L.LayerId | null })
			| Omit<SE.RconDisconnected, 'matchId'>
		)[]
		teamsUpdates: TeamsUpdateEvent[]
	}

	attributions: Attribution[]

	// players from the last =<2 matches
	nextLayerId: L.LayerId | null
	expectedNewLayerId: L.LayerId | null

	currentMatch: {
		historyEntryId: number
		layerId: L.LayerId
	} | 'PENDING'

	// 'rolling' means we're expecting a NEW_GAME event soon
	syncState:
		| { type: 'desynced' }
		| { type: 'syncing'; isNewMatch: boolean }
		| { type: 'rolling'; newGameEvent?: SM.LogEvents.NewGame & { id: number } }
		| { type: 'synced' }

	isFirstConnection: boolean | null
	admins: Set<string>
	currTeams: SM.UniqueTeams | null
	counters: {
		eventId: Generator<number, never, unknown>
		squadId: Generator<number, never, unknown>
		pendingEventId: Generator<number, never, unknown>
	}
	log: CS.Logger
	hooks: {
		onNewGameDuringRoll: (newLayerId: L.LayerId, time: number) => Promise<{ match: MH.MatchDetails; nextLayerId: L.LayerId | null }>
		onNewGameDuringSync: (newLayerId: L.LayerId, time: number) => Promise<{ match: MH.MatchDetails; isNewMatch: boolean }>
		fetchLayersStatus: () => Promise<SM.LayersStatus | null>
	}

	// if we receive a non-log event and we haven't received a log event in this amount of time since the time of the received event, we can assume that there are no log events older than this time that we have yet to receive
	minSafeLeadTimeForOtherEventsSinceLog: number

	debug__ticketOutcome?: { team1: number; team2: number }
}

type StateWithCurrentMatchAndPlayers = State & {
	currentMatch: { historyEntryId: number; layerId: L.LayerId }
	currTeams: SM.UniqueTeams
}

type PendingEvent = State['eventBufs'][keyof State['eventBufs']][number]

export const TeamModifyingEventTypes = z.enum(
	[
		'NEW_GAME',
		'RESET',
		'PLAYER_CONNECTED',
		'PLAYER_DISCONNECTED',
		'PLAYER_CHANGED_TEAM',
	] satisfies SE.Event['type'][],
)

export function init(
	opts: {
		currentMatch: State['currentMatch']
		hooks: State['hooks']
		counters: Omit<State['counters'], 'pendingEventId'>
		log: State['log']
		minSafeLogLeadTimeForOtherEvents?: State['minSafeLeadTimeForOtherEventsSinceLog']
	},
): State {
	return {
		lastKnownLogEventTime: null,
		admins: new Set(),
		currTeams: null,
		expectedNewLayerId: null,
		eventBufs: {
			rconEmittedEvents: [],
			logEvents: [],
			lifecycleEvents: [],
			teamsUpdates: [],
		},
		attributions: [],
		nextLayerId: null,
		currentMatch: opts.currentMatch,
		syncState: { type: 'desynced' },
		counters: { ...opts.counters, pendingEventId: Gen.counter() },
		log: opts.log,
		hooks: opts.hooks,
		isFirstConnection: null,
		minSafeLeadTimeForOtherEventsSinceLog: opts.minSafeLogLeadTimeForOtherEvents ?? Infinity,
	}
}

export function pushAttribution(state: State, attribution: Omit<Attribution, 'time' | 'time'>) {
	state.attributions.push({ ...attribution, time: Date.now() })
}

export function onRconConnected(state: State, time: number, nextLayerId: L.LayerId | null, currentLayerId: L.LayerId) {
	state.eventBufs.lifecycleEvents.push({
		type: 'RCON_CONNECTED',
		time,
		id: Gen.next(state.counters.pendingEventId),
		currentLayerId,
		nextLayerId,
	})
}

export function onLogEvent(state: State, event: SM.LogEvents.ParsedEvent) {
	state.eventBufs.logEvents.push({ ...event, id: Gen.next(state.counters.pendingEventId) })
}

export function onRconDisconnected(state: State, time: number) {
	state.eventBufs.lifecycleEvents.push({ type: 'RCON_DISCONNECTED', time, id: Gen.next(state.counters.pendingEventId) })
}

export function onRconEvent(state: State, event: SM.RconEvents.Event) {
	state.eventBufs.rconEmittedEvents.push({ ...event, id: Gen.next(state.counters.pendingEventId) })
}

export function onTeamsPolled(state: State, teams: SM.Teams, time: number) {
	const lastEvent = state.eventBufs.teamsUpdates.at(-1)
	if (!!lastEvent && lastEvent.time > time) {
		throw new Error(`Teams polled with time ${time} is older than last event time ${lastEvent.time}`)
	}
	state.eventBufs.teamsUpdates.push({ type: 'TEAMS_UPDATE', id: Gen.next(state.counters.pendingEventId), teams, time })
}

export async function* process(
	state: State,
	time: number,
): AsyncGenerator<SE.Event> {
	const log = state.log
	const toProcess: PendingEvent[] = []
	const comparator = (a: PendingEvent, b: PendingEvent) => a.time - b.time

	for (let i = 0; i < state.eventBufs.logEvents.length; i++) {
		const logEvent = state.eventBufs.logEvents[i]
		if (i > 0 && logEvent.time < state.eventBufs.logEvents[i - 1].time) {
			throw new Error(`logEvents out of order at index ${i}: ${state.eventBufs.logEvents[i - 1].time} > ${logEvent.time}`)
		}
		if (state.lastKnownLogEventTime === null || logEvent.time > state.lastKnownLogEventTime) {
			state.lastKnownLogEventTime = logEvent.time
		}
		Arr.insertIntoSorted(toProcess, logEvent, comparator)
	}

	for (const lifecycleEvt of state.eventBufs.lifecycleEvents) {
		// if (state.lastKnownLogEventTime == null || state.lastKnownLogEventTime < lifecycleEvt.time) continue
		Arr.insertIntoSorted(toProcess, lifecycleEvt, comparator)
	}

	for (const rconEvent of state.eventBufs.rconEmittedEvents) {
		if (
			state.lastKnownLogEventTime === null || state.lastKnownLogEventTime < rconEvent.time
				// if the event has been sitting for the min safe lead time, then it's(probably) safe to process
				&& rconEvent.time + state.minSafeLeadTimeForOtherEventsSinceLog > time
		) continue
		Arr.insertIntoSorted(toProcess, rconEvent, comparator)
	}

	for (const teamUpdateEvent of state.eventBufs.teamsUpdates) {
		if (
			state.lastKnownLogEventTime === null || state.lastKnownLogEventTime < teamUpdateEvent.time
				// if the event has been sitting for the min safe lead time, then it's(probably) safe to process
				&& teamUpdateEvent.time + state.minSafeLeadTimeForOtherEventsSinceLog > time
		) continue
		Arr.insertIntoSorted(toProcess, teamUpdateEvent, comparator)
	}

	const processedEventIds = new Set<number>()
	const ctx = { log, ...CS.init() }
	for (let i = 0; i < toProcess.length; i++) {
		const pendingEvent = toProcess[i]
		try {
			for await (const event of processPendingEvent(state, processedEventIds, time, pendingEvent)) {
				if (event.type === 'NEW_GAME' || event.type === 'RESET' && !state.currTeams) {
					state.currTeams = initUniqueTeams(state, { players: [], squads: [] })
				}
				if (state.currTeams) {
					applyEventTeamMutations(ctx, state.currTeams, event)
				}
				yield event
			}
		} catch (err) {
			state.log.error(err, 'Error while processing event %s (%s)', pendingEvent.type, pendingEvent.id)
			processedEventIds.add(pendingEvent.id)
		}
	}
	for (const prop of Obj.objKeys(state.eventBufs)) {
		// @ts-expect-error idgaf
		state.eventBufs[prop] = state.eventBufs[prop].filter(e => !processedEventIds.has(e.id))
	}
}

export function applyEventTeamMutations(ctx: CS.Log, teams: SM.UniqueTeams, event: SE.Event) {
	const log = ctx.log
	switch (event.type) {
		case 'NEW_GAME':
		case 'RESET': {
			teams.players.splice(0, teams.players.length, ...event.state.players)
			teams.squads.splice(0, teams.squads.length, ...event.state.squads)
			teams.squads.sort((a, b) => a.squadId - b.squadId)
			break
		}

		case 'SQUAD_CREATED': {
			const existingSquad = teams.squads.find(s => s.uniqueId === event.squad.uniqueId)
			if (existingSquad) {
				log.warn(`Squad %s already exists`, event.squad.uniqueId)
				break
			}
			const squad: SM.UniqueSquad = event.squad
			const creatorIndex = SM.PlayerIds.indexOf(teams.players, p => p.ids, event.squad.creator)
			if (creatorIndex === -1) {
				log.warn(
					`Squad ${SM.Squads.printKey(squad)} "${event.squad.squadName}" created by unknown player ${
						SM.PlayerIds.prettyPrint(squad.creator)
					}`,
				)
				break
			}
			const creator = teams.players[creatorIndex]
			if (creator.teamId !== squad.teamId) {
				log.warn(
					`Creator ${SM.PlayerIds.prettyPrint(creator.ids)} is not in the same team as the squad they created ${SM.Squads.printKey(squad)}`,
				)
				break
			}
			const insertIndex = teams.squads.findIndex(s => s.squadId > squad.squadId)
			if (insertIndex === -1) {
				teams.squads.push(squad)
			} else {
				teams.squads.splice(insertIndex, 0, squad)
			}
			teams.players[creatorIndex] = { ...creator, isLeader: true, squadId: squad.squadId }
			break
		}

		case 'PLAYER_CHANGED_TEAM': {
			const index = SM.PlayerIds.indexOf(teams.players, p => p.ids, event.player)
			if (index === -1) {
				log.warn('Player not found for team change: %s', event.player)
				break
			}
			teams.players[index] = { ...teams.players[index], teamId: event.newTeamId }
			break
		}

		case 'PLAYER_JOINED_SQUAD': {
			const playerIndex = SM.PlayerIds.indexOf(teams.players, p => p.ids, event.player)
			if (playerIndex === -1) {
				log.warn('Player not found for squad join: %s', event.player)
				break
			}
			const squad = teams.squads.find(s => s.uniqueId === event.uniqueId)
			if (!squad) {
				log.warn('Squad not found for squad join: %s', event.uniqueId)
				break
			}
			teams.players[playerIndex] = { ...teams.players[playerIndex], squadId: squad.squadId, isLeader: false }
			break
		}

		case 'PLAYER_LEFT_SQUAD': {
			const index = SM.PlayerIds.indexOf(teams.players, p => p.ids, event.player)
			if (index === -1) {
				log.warn('Player not found for squad leave: %s', event.player)
				break
			}
			teams.players[index] = { ...teams.players[index], squadId: null, isLeader: false }
			break
		}

		case 'PLAYER_PROMOTED_TO_LEADER': {
			const playerIndex = SM.PlayerIds.indexOf(teams.players, p => p.ids, event.player)
			if (playerIndex === -1) {
				log.warn('Player not found for promotion: %s', event.player)
				break
			}
			const promotedPlayer = teams.players[playerIndex]
			if (!promotedPlayer.squadId) {
				log.warn('Player has no squad for promotion: %s', event.player)
				break
			}
			for (let i = 0; i < teams.players.length; i++) {
				const p = teams.players[i]
				if (!SM.Squads.idsEqual(p, promotedPlayer)) continue
				const isNewLeader = i === playerIndex
				if (p.isLeader === isNewLeader) continue
				teams.players[i] = { ...p, isLeader: isNewLeader }
			}
			break
		}

		case 'SQUAD_DISBANDED': {
			const squadIndex = teams.squads.findIndex(s => s.uniqueId === event.uniqueId)
			if (squadIndex === -1) {
				log.warn('Squad not found for disband: %s', event.uniqueId)
				break
			}
			teams.squads.splice(squadIndex, 1)
			break
		}

		case 'PLAYER_DETAILS_CHANGED': {
			const index = SM.PlayerIds.indexOf(teams.players, p => p.ids, event.player)
			if (index === -1) {
				log.warn('Player not found for details change: %s', event.player)
				break
			}
			const player = teams.players[index]
			teams.players[index] = { ...player, ...event.details, ids: { ...player.ids, username: event.newUsername ?? player.ids.username } }
			break
		}

		case 'SQUAD_DETAILS_CHANGED': {
			const index = teams.squads.findIndex(s => s.uniqueId === event.uniqueId)
			if (index === -1) {
				log.warn('Squad not found for details change: %s', event.uniqueId)
				break
			}
			teams.squads[index] = { ...teams.squads[index], ...event.details }
			break
		}

		case 'SQUAD_RENAMED': {
			const index = teams.squads.findIndex(s => s.uniqueId === event.uniqueId)
			if (index === -1) {
				log.warn('Squad not found for rename: %s', event.uniqueId)
				break
			}
			teams.squads[index] = { ...teams.squads[index], squadName: event.newSquadName }
			break
		}

		case 'PLAYER_CONNECTED': {
			const existingPlayerIndex = SM.PlayerIds.indexOf(teams.players, p => p.ids, event.player.ids)
			if (existingPlayerIndex !== -1) {
				log.warn(`Player ${SM.PlayerIds.prettyPrint(event.player.ids)} connected but was already in the player list`)
				teams.players[existingPlayerIndex] = event.player
			} else {
				teams.players.push(event.player)
			}
			break
		}

		case 'PLAYER_DISCONNECTED': {
			const index = SM.PlayerIds.indexOf(teams.players, p => p.ids, event.player)
			if (index === -1) {
				log.warn(`Player ${SM.PlayerIds.prettyPrint(event.player)} disconnected but was not found in the player list`)
				break
			}
			teams.players.splice(index, 1)
			break
		}
	}
}

async function* processPendingEvent(
	state: State,
	processedEventIds: Set<number>,
	time: number,
	pendingEvent: PendingEvent,
): AsyncGenerator<SE.Event> {
	const log = state.log

	if (pendingEvent.type !== 'UNKNOWN') {
		log.debug('Attempting to process raw event %s (%s) %s', pendingEvent.type, pendingEvent.id)
	}

	if (pendingEvent.time < time - 45_000) {
		state.log.warn('Skipping event %s (%s) as it is stale (%s)', pendingEvent.type, pendingEvent.id, pendingEvent.time)
		processedEventIds.add(pendingEvent.id)
		return
	}

	if (pendingEvent.type === 'RCON_CONNECTED' && state.syncState.type !== 'rolling') {
		const { match, isNewMatch } = await state.hooks.onNewGameDuringSync(
			pendingEvent.currentLayerId,
			pendingEvent.time,
		)
		state.syncState = { type: 'syncing', isNewMatch }
		state.currentMatch = {
			historyEntryId: match.historyEntryId,
			layerId: match.layerId,
		}

		state.isFirstConnection = state.isFirstConnection === null
		yield {
			type: 'RCON_CONNECTED',
			matchId: state.currentMatch.historyEntryId,
			time: pendingEvent.time,
			reconnected: !state.isFirstConnection,
			id: Gen.next(state.counters.eventId),
		}

		if (
			pendingEvent.nextLayerId !== null && (state.nextLayerId === null || !L.layersEqual(state.nextLayerId, pendingEvent.nextLayerId))
		) {
			state.nextLayerId = pendingEvent.nextLayerId
			yield {
				type: 'MAP_SET',
				layerId: state.nextLayerId,
				id: Gen.next(state.counters.eventId),
				matchId: state.currentMatch.historyEntryId,
				time: Date.now(),
			}
		}
	}

	if (pendingEvent.type === 'RCON_DISCONNECTED') {
		if (state.syncState.type !== 'rolling') {
			state.syncState = { type: 'desynced' }
		}
		state.currTeams = null
		if (state.currentMatch !== 'PENDING') {
			yield {
				type: 'RCON_DISCONNECTED',
				time: pendingEvent.time,
				id: Gen.next(state.counters.eventId),
				matchId: state.currentMatch.historyEntryId,
			}
		}
	}

	outerIf: if (pendingEvent.type === 'TEAMS_UPDATE' && state.syncState.type === 'syncing') {
		if (state.currentMatch === 'PENDING') throw new Error('Unexpected missing current match')
		for (const player of pendingEvent.teams.players) {
			if (player.teamId == null) {
				break outerIf
			}
		}
		const teams = initUniqueTeams(state, pendingEvent.teams)

		if (state.syncState.isNewMatch) {
			yield {
				type: 'NEW_GAME',
				id: Gen.next(state.counters.eventId),
				layerId: state.currentMatch.layerId,
				matchId: state.currentMatch.historyEntryId,
				source: state.isFirstConnection ? 'slm-started' : 'rcon-reconnected',
				state: teams,
				time: pendingEvent.time,
			}
		} else {
			yield {
				type: 'RESET',
				matchId: state.currentMatch.historyEntryId,
				state: teams,
				time: pendingEvent.time,
				id: Gen.next(state.counters.eventId),
				source: state.isFirstConnection ? 'slm-started' : 'rcon-reconnected',
			}
		}
		state.syncState = { type: 'synced' }
	}

	outerIf: if (
		pendingEvent.type === 'TEAMS_UPDATE' && state.syncState.type === 'rolling' && !!state.syncState.newGameEvent
		&& state.syncState.newGameEvent.time < pendingEvent.time
		&& state.currentMatch !== 'PENDING'
	) {
		for (const player of pendingEvent.teams.players) {
			if (player.teamId == null) {
				break outerIf
			}
		}

		state.currTeams = initUniqueTeams(state, pendingEvent.teams)

		const event = state.syncState.newGameEvent
		yield {
			type: 'NEW_GAME',
			id: Gen.next(state.counters.eventId),
			time: event.time,
			matchId: state.currentMatch.historyEntryId,
			layerId: state.currentMatch.layerId,
			state: Obj.deepClone(state.currTeams),
			source: 'server-roll',
		}
		state.syncState = { type: 'synced' }
	}

	if (pendingEvent.type === 'NEW_GAME') {
		if (pendingEvent.layerClassname === 'TransitionMap') {
			state.syncState = { type: 'rolling' }
			state.currTeams = null
			state.expectedNewLayerId = state.nextLayerId
		} else {
			let newLayerId = state.expectedNewLayerId
			state.expectedNewLayerId = null
			state.syncState = { type: 'rolling', newGameEvent: pendingEvent }
			if (!newLayerId || !L.layerMatchesIngameLayerClassname(newLayerId, pendingEvent.layerClassname)) {
				if (pendingEvent.layerClassname) {
					log.error(`layerClassname mismatch: expected ${newLayerId}, got ${pendingEvent.layerClassname}`)
				} else {
					log.warn('expectedNewLayerId is null')
				}
				const layersStatus = await state.hooks.fetchLayersStatus()
				if (!layersStatus) {
					log.warn('fetchLayersStatus returned null')
					processedEventIds.add(pendingEvent.id)
					return
				}
				newLayerId = layersStatus.currentLayer.id
			}

			const { match, nextLayerId } = await state.hooks.onNewGameDuringRoll(newLayerId, pendingEvent.time)
			state.currentMatch = {
				historyEntryId: match.historyEntryId,
				layerId: match.layerId,
			}
			state.expectedNewLayerId = null
			if (nextLayerId !== null) {
				// we don't emit a MAP_SET event here as we've assumd the caller has already handled this logic in onNewGameDuringRoll
				state.nextLayerId = nextLayerId
			}
		}
	}

	if (state.syncState.type !== 'synced' || state.currentMatch === 'PENDING') {
		processedEventIds.add(pendingEvent.id)
		return
	}
	if (!state.currTeams) throw new Error('currTeams is null when synced')

	const base = {
		id: Gen.next(state.counters.eventId),
		matchId: state.currentMatch.historyEntryId,
		time: pendingEvent.time,
	}

	switch (pendingEvent.type) {
		case 'MAP_SET': {
			let layer = L.parseRawLayerText(`${pendingEvent.nextLayer} ${pendingEvent.nextFactions ?? ''}`.trim())
			if (!layer || !L.isKnownLayer(layer)) {
				const layersStatus = await state.hooks.fetchLayersStatus()
				if (!layersStatus || !layersStatus.nextLayer) {
					log.error(`Unable to resolve layer on MAP_SET`)
					break
				}
				layer = layersStatus.nextLayer
			}
			let source: SE.MapSet['source'] = pendingEvent.source
			state.nextLayerId = layer.id
			const attributionIndex = state.attributions.findIndex(a => a.type === 'MAP_SET_ATTRIBUTION')
			if (attributionIndex !== -1) {
				const attribution = state.attributions[attributionIndex]
				if (L.areLayersCompatible(attribution.layerId, layer.id)) {
					source = { type: 'layer-queue', itemId: attribution.itemId }
				}
				state.attributions.splice(attributionIndex, 1)
			}
			yield {
				type: 'MAP_SET',
				...base,
				layerId: layer.id,
				source,
			}
			break
		}

		case 'ROUND_ENDED_CHAIN': {
			let loser: SM.SquadOutcomeTeam | null
			let winner: SM.SquadOutcomeTeam | null

			if (state.debug__ticketOutcome) {
				let winnerId: SM.TeamId | null
				let loserId: SM.TeamId | null
				if (state.debug__ticketOutcome.team1 === state.debug__ticketOutcome.team2) {
					winnerId = null
					loserId = null
				} else {
					winnerId = state.debug__ticketOutcome.team1 - state.debug__ticketOutcome.team2 > 0 ? 1 : 2
					loserId = state.debug__ticketOutcome.team1 - state.debug__ticketOutcome.team2 < 0 ? 1 : 2
				}
				const partial = L.toLayer(state.currentMatch.layerId)
				const teams: SM.SquadOutcomeTeam[] = [
					{
						faction: partial.Faction_1!,
						unit: partial.Unit_1!,
						team: 1,
						tickets: state.debug__ticketOutcome.team1,
					},
					{
						faction: partial.Faction_2!,
						unit: partial.Unit_2!,
						team: 2,
						tickets: state.debug__ticketOutcome.team2,
					},
				]
				winner = teams.find(t => t?.team && t.team === winnerId) ?? null
				loser = teams.find(t => t?.team && t.team === loserId) ?? null
				delete state.debug__ticketOutcome
			} else if (!pendingEvent.events.ROUND_DECIDED_WINNER || pendingEvent.events.ROUND_DECIDED_WINNER.team === -1) {
				winner = null
				loser = null
			} else {
				winner = {
					faction: pendingEvent.events.ROUND_DECIDED_WINNER.faction,
					team: pendingEvent.events.ROUND_DECIDED_WINNER.team as SM.TeamId,
					tickets: pendingEvent.events.ROUND_DECIDED_WINNER.tickets,
					unit: pendingEvent.events.ROUND_DECIDED_WINNER.unit,
				}
				loser = {
					faction: pendingEvent.events.ROUND_DECIDED_LOSER.faction,
					team: pendingEvent.events.ROUND_DECIDED_LOSER.team as SM.TeamId,
					tickets: pendingEvent.events.ROUND_DECIDED_LOSER.tickets,
					unit: pendingEvent.events.ROUND_DECIDED_LOSER.unit,
				}
			}
			let outcome: MH.MatchOutcome
			if (!winner) {
				outcome = {
					type: 'draw',
				}
			} else {
				const [team1, team2] = winner.team === 1 ? [winner, loser] : [loser, winner]
				outcome = {
					type: winner.team === 1 ? 'team1' : 'team2',
					team1Tickets: team1!.tickets,
					team2Tickets: team2!.tickets,
				}
			}

			log.info('got ROUND_ENDED_CHAIN %o', pendingEvent)
			let action: SE.RoundEnded['action']
			actionHandler: if (pendingEvent.events.LAYER_CHANGED) {
				const layerChanged = pendingEvent.events.LAYER_CHANGED
				let layer = L.parseRawLayerText(layerChanged.layer)
				if (!layer || !L.isKnownLayer(layer)) {
					const layersStatus = await state.hooks.fetchLayersStatus()
					if (!layersStatus || !layersStatus.nextLayer) {
						break actionHandler
					}
					layer = layersStatus.nextLayer
				}
				if (!layer) {
					log.error(`Failed to parse layer text: ${layerChanged.layer}`)
					break
				} else {
					action = {
						type: 'AdminChangeLayer',
						source: layerChanged.source,
						layerId: layer.id,
					}
					state.nextLayerId = layer.id
				}
			} else if (pendingEvent.events.ADMIN_ENDED_MATCH) {
				const endedMatch = pendingEvent.events.ADMIN_ENDED_MATCH
				action = {
					type: 'AdminEndMatch',
					source: endedMatch.source,
				}
			}

			const event: SE.RoundEnded = {
				type: 'ROUND_ENDED',
				outcome,
				action: action,
				...base,
			}

			yield event

			break
		}

		case 'PLAYER_KICKED_CHAIN': {
			const events = pendingEvent.events
			yield {
				...base,
				type: 'PLAYER_KICKED',
				player: SM.PlayerIds.getPlayerId(events.PLAYER_KICKED.playerIds),
				reason: events.KICKING_PLAYER.reason,
			}
			break
		}

		// carryover from squadjs, no recent instances of this in current prod logs
		case 'PLAYER_BANNED': {
			yield {
				...base,
				type: 'PLAYER_BANNED',
				player: SM.PlayerIds.getPlayerId(pendingEvent.playerIds),
				interval: pendingEvent.interval,
			}
			break
		}

		case 'PLAYER_WARNED': {
			const player = SM.PlayerIds.find(state.currTeams.players, p => p.ids, pendingEvent.playerIds)
			if (!player) {
				log.error('Player not found in recentPlayers: %s', SM.PlayerIds.prettyPrint(pendingEvent.playerIds))
				break
			}
			yield {
				...base,
				type: 'PLAYER_WARNED',
				reason: pendingEvent.reason,
				player: SM.PlayerIds.getPlayerId(player.ids),
			}
			break
		}

		case 'POSSESSED_ADMIN_CAMERA': {
			yield {
				...base,
				type: 'POSSESSED_ADMIN_CAMERA',
				player: SM.PlayerIds.getPlayerId(pendingEvent.playerIds),
			}
			break
		}

		case 'UNPOSSESSED_ADMIN_CAMERA': {
			yield {
				...base,
				type: 'UNPOSSESSED_ADMIN_CAMERA',
				player: SM.PlayerIds.getPlayerId(pendingEvent.playerIds),
			}
			break
		}

		case 'PLAYER_CONNECTED_CHAIN': {
			const events = pendingEvent.events
			const player: SM.Player = {
				ids: {
					...events.PLAYER_CONNECTED.playerIds,
					...events.PLAYER_JOIN_SUCCEEDED.player,
					username: events.PLAYER_JOIN_SUCCEEDED.player.usernameNoTag,
				},
				teamId: events.PLAYER_ADDED_TO_TEAM?.teamId ?? 1,
				squadId: null,
				isLeader: false,
				isAdmin: state.admins.has(SM.PlayerIds.getPlayerId(events.PLAYER_CONNECTED.playerIds)),
				role: 'unknown',
			}

			yield {
				type: 'PLAYER_CONNECTED',
				...base,
				player: Obj.deepClone(player),
			}
			break
		}

		case 'SQUAD_CREATED': {
			const factionId = L.getFactionIdForFactionNameInexact(pendingEvent.teamName)
			if (!factionId) {
				log.error(`unable to resolve faction id for team name ${pendingEvent.teamName}`)
				break
			}
			const layer = L.toLayer(state.currentMatch.layerId)

			let teamId: SM.TeamId
			if (layer.Faction_1 && layer.Faction_1 === factionId) {
				teamId = 1
			} else if (layer.Faction_2 && layer.Faction_2 === factionId) {
				teamId = 2
			} else {
				log.error(`unable to resolve team id for squad created with team name ${pendingEvent.teamName} (factionId=${factionId})`)
				break
			}

			const squad: SM.UniqueSquad = {
				teamId,
				squadId: pendingEvent.squadId,
				creator: SM.PlayerIds.getPlayerId(pendingEvent.creatorIds),
				uniqueId: Gen.next(state.counters.squadId),
				squadName: pendingEvent.squadName,
				// will be updated later if incorrect
				locked: false,
			}

			const player = SM.PlayerIds.find(state.currTeams?.players, p => p.ids, pendingEvent.creatorIds)
			if (!player) {
				break
			}
			const existingSquad = state.currTeams.squads.find(s => SM.Squads.idsEqual(s, squad))
			if (existingSquad) {
				for (const player of state.currTeams.players) {
					if (!SM.Squads.idsEqual(player, squad)) continue
					yield {
						type: 'PLAYER_LEFT_SQUAD',
						id: Gen.next(state.counters.eventId),
						player: SM.PlayerIds.getPlayerId(player.ids),
						uniqueId: squad.uniqueId,
						matchId: state.currentMatch.historyEntryId,
						time: pendingEvent.time,
					}
				}

				yield {
					type: 'SQUAD_DISBANDED',
					id: Gen.next(state.counters.eventId),
					uniqueId: squad.uniqueId,
					matchId: state.currentMatch.historyEntryId,
					time: pendingEvent.time,
				}
			}

			if (player.squadId && (!existingSquad || !SM.Squads.idsEqual(player, existingSquad))) {
				yield* emitLeaveSquadEvents(state as StateWithCurrentMatchAndPlayers, pendingEvent.time, player, squad.uniqueId)
			}

			if (player.teamId !== teamId) {
				yield {
					type: 'PLAYER_CHANGED_TEAM',
					id: Gen.next(state.counters.eventId),
					player: SM.PlayerIds.getPlayerId(player.ids),
					newTeamId: teamId,
					time: pendingEvent.time,
					matchId: state.currentMatch.historyEntryId,
				}
			}

			yield {
				type: 'SQUAD_CREATED',
				squad: squad,
				...base,
			}

			break
		}

		case 'PLAYER_DISCONNECTED': {
			if (!state.currTeams) break
			const player = SM.PlayerIds.find(state.currTeams.players, p => p.ids, pendingEvent.playerIds)
			if (player) {
				if (player.squadId) {
					yield* emitLeaveSquadEvents(state as StateWithCurrentMatchAndPlayers, pendingEvent.time, player, player.squadId)
				}
			} else {
				log.warn(`Player not found on disconnect: ${SM.PlayerIds.prettyPrint(pendingEvent.playerIds)}`)
				break
			}
			yield {
				type: 'PLAYER_DISCONNECTED',
				player: SM.PlayerIds.getPlayerId(pendingEvent.playerIds),
				...base,
			}
			break
		}

		case 'SQUAD_RENAMED': {
			const squad = state.currTeams.squads.find(s => s.squadId === pendingEvent.squadId && s.teamId === pendingEvent.teamId)
			if (!squad) {
				log.error('SQUAD_RENAMED: squad not found for squadId=%d, teamId=%d', pendingEvent.squadId, pendingEvent.teamId)
				break
			}
			yield {
				type: 'SQUAD_RENAMED',
				uniqueId: squad.uniqueId,
				oldSquadName: pendingEvent.oldSquadName,
				newSquadName: pendingEvent.newSquadName,
				...base,
			}
			break
		}

		case 'TEAMS_UPDATE': {
			const events = Array.from(reconcileTeamsUpdate(state, pendingEvent))
			yield* events
			break
		}

		case 'PLAYER_DIED':
		case 'PLAYER_WOUNDED': {
			const victim = SM.PlayerIds.find(state.currTeams.players, p => p.ids, pendingEvent.victimIds)
			const attacker = SM.PlayerIds.find(state.currTeams.players, p => p.ids, pendingEvent.attackerIds)
			if (!victim || !attacker) {
				const missing: string[] = []
				if (!victim) missing.push(`victim: ${SM.PlayerIds.prettyPrint(pendingEvent.victimIds)}`)
				if (!attacker) missing.push(`attacker: ${SM.PlayerIds.prettyPrint(pendingEvent.attackerIds)}`)
				log.warn(`Player died/wounded with missing victim or attacker: %s %s`, missing.join(', '), JSON.stringify(pendingEvent))
				break
			}

			let variant: SE.PlayerWoundedOrDiedVariant
			if (SM.PlayerIds.match(victim.ids, attacker.ids)) {
				variant = 'suicide'
			} else if (victim.teamId !== null && victim.teamId === attacker.teamId) {
				variant = 'teamkill'
			} else {
				variant = 'normal'
			}

			yield {
				type: pendingEvent.type,
				...base,
				damage: pendingEvent.damage,
				weapon: pendingEvent.weapon,
				variant,
				attacker: SM.PlayerIds.getPlayerId(attacker.ids),
				victim: SM.PlayerIds.getPlayerId(victim.ids),
			}

			break
		}

		case 'CHAT_MESSAGE': {
			let channel: SM.ChatChannel
			if (pendingEvent.channelType === 'ChatAdmin' || pendingEvent.channelType === 'ChatAll') {
				channel = { type: pendingEvent.channelType }
			} else if (pendingEvent.channelType === 'ChatTeam' || pendingEvent.channelType === 'ChatSquad') {
				const player = SM.PlayerIds.find(state.currTeams.players, p => p.ids, pendingEvent.playerIds)
				if (!player) {
					log.error(`player ${SM.PlayerIds.prettyPrint(pendingEvent.playerIds)} not found`)
					break
				}
				if (player.teamId === null) {
					log.error(`player ${SM.PlayerIds.prettyPrint(player.ids)} is not in a team`)
					break
				}

				if (player.squadId === null && pendingEvent.channelType === 'ChatSquad') {
					log.error(`player ${SM.PlayerIds.prettyPrint(player.ids)} is not in a squad`)
					break
				}

				if (pendingEvent.channelType === 'ChatTeam') {
					channel = { type: pendingEvent.channelType, teamId: player.teamId }
				} else {
					if (player.squadId === null) {
						log.error(`player ${SM.PlayerIds.prettyPrint(player.ids)} is not in a squad`)
						break
					}
					channel = { type: pendingEvent.channelType, teamId: player.teamId, squadId: player.squadId }
				}
			} else {
				assertNever(pendingEvent.channelType)
			}

			if (channel.type === 'ChatSquad') {
				const squadChannel = channel
				const squad = state.currTeams.squads.find(s => SM.Squads.idsEqual(s, squadChannel))
				if (squad) channel = { ...squadChannel, uniqueId: squad.uniqueId }
			}

			yield {
				type: 'CHAT_MESSAGE',
				message: pendingEvent.message,
				player: SM.PlayerIds.getPlayerId(pendingEvent.playerIds),
				channel,
				...base,
			}
			break
		}

		case 'ADMIN_BROADCAST': {
			yield {
				type: 'ADMIN_BROADCAST',
				message: pendingEvent.message,
				source: pendingEvent.source,
				...base,
			}
			break
		}
	}

	processedEventIds.add(pendingEvent.id)
}

function* reconcileTeamsUpdate(state: State, event: TeamsUpdateEvent): Generator<SE.Event> {
	const nextTeams = event.teams
	if (!state.currTeams || state.currentMatch === 'PENDING') return
	const nextSquads: SM.UniqueSquad[] = []
	const base = { matchId: state.currentMatch.historyEntryId, time: event.time }
	const log = state.log

	for (const squad of nextTeams.squads) {
		const prevSquad = state.currTeams.squads.find(s => SM.Squads.idsEqual(s, squad) && s.creator === squad.creator)
		if (!prevSquad) {
			// we want the SQUAD_CREATED event to have always landed before attempting to process teams updates
			log.debug('Squad not found for update: %s, skipping update cycle', SM.Squads.printKey(squad))
			return
		}
		nextSquads.push({
			...squad,
			uniqueId: prevSquad.uniqueId,
		})
	}

	let emittedEvent = false

	for (const nextPlayer of nextTeams.players) {
		const playerId = SM.PlayerIds.getPlayerId(nextPlayer.ids)
		const currPlayer = SM.PlayerIds.find(state.currTeams.players, p => p.ids, nextPlayer.ids)
		const squad = nextPlayer.squadId && nextSquads.find(s => SM.Squads.idsEqual(s, nextPlayer))
		const currSquad = currPlayer?.squadId
			&& state.currTeams.squads.find(s => SM.Squads.idsEqual(s, { squadId: currPlayer.squadId, teamId: currPlayer.teamId }))

		if (currSquad && (!squad || currSquad.uniqueId !== squad.uniqueId)) {
			// currPlayer.squadId = null
			emittedEvent = true
			yield {
				id: Gen.next(state.counters.eventId),
				type: 'PLAYER_LEFT_SQUAD',
				player: playerId,
				uniqueId: currSquad.uniqueId,
				...base,
			}
		}
	}

	const disbandedSquads = new Set<number>()
	for (const currSquad of state.currTeams.squads) {
		const nextSquad = nextSquads.find(s => s.uniqueId === currSquad.uniqueId)
		if (!nextSquad) {
			disbandedSquads.add(currSquad.uniqueId)
			emittedEvent = true
			yield {
				id: Gen.next(state.counters.eventId),
				type: 'SQUAD_DISBANDED',
				uniqueId: currSquad.uniqueId,
				...base,
			}
			continue
		}

		const details = Obj.selectProps(nextSquad, SM.SQUAD_DETAILS)
		const prevDetails = Obj.selectProps(currSquad, SM.SQUAD_DETAILS)
		if (!Obj.deepEqual(details, prevDetails)) {
			emittedEvent = true
			yield {
				id: Gen.next(state.counters.eventId),
				type: 'SQUAD_DETAILS_CHANGED',
				uniqueId: currSquad.uniqueId,
				details,
				...base,
			}
		}
	}

	for (const nextPlayer of nextTeams.players) {
		const playerId = SM.PlayerIds.getPlayerId(nextPlayer.ids)
		const currPlayer = SM.PlayerIds.find(state.currTeams.players, p => p.ids, nextPlayer.ids)

		if (currPlayer && nextPlayer.teamId !== currPlayer.teamId) {
			emittedEvent = true
			yield {
				id: Gen.next(state.counters.eventId),
				type: 'PLAYER_CHANGED_TEAM',
				player: playerId,
				newTeamId: nextPlayer.teamId,
				...base,
			}
		}
	}

	for (const player of nextTeams.players) {
		const playerId = SM.PlayerIds.getPlayerId(player.ids)
		const prevPlayer = SM.PlayerIds.find(state.currTeams.players, p => p.ids, player.ids)
		const squad = (player.squadId && nextSquads.find(s => SM.Squads.idsEqual(s, player))) || undefined

		let prevSquad = (prevPlayer?.squadId && state.currTeams.squads.find(s => SM.Squads.idsEqual(s, prevPlayer))) || undefined

		if (squad) {
			const hasChangedSquad = squad.uniqueId !== prevSquad?.uniqueId

			if (hasChangedSquad) {
				emittedEvent = true
				yield {
					id: Gen.next(state.counters.eventId),
					type: 'PLAYER_JOINED_SQUAD',
					uniqueId: squad.uniqueId,
					player: playerId,
					...base,
				}
			}

			if (player.isLeader && !prevPlayer?.isLeader) {
				if (!player.squadId) {
					log.warn('Attempted to promote player leader but has no squad: %s', playerId)
					return
				}
				emittedEvent = true
				yield {
					id: Gen.next(state.counters.eventId),
					type: 'PLAYER_PROMOTED_TO_LEADER',
					uniqueId: squad.uniqueId,
					player: playerId,
					...base,
				}
			}
		}

		if (prevPlayer) {
			const details = Obj.selectProps(player, SM.PLAYER_DETAILS)
			const prevDetails = Obj.selectProps(prevPlayer, SM.PLAYER_DETAILS)
			const newUsername = prevPlayer.ids.username !== player.ids.username ? player.ids.username : undefined
			if (!Obj.deepEqual(details, prevDetails) || newUsername) {
				emittedEvent = true
				yield {
					id: Gen.next(state.counters.eventId),
					type: 'PLAYER_DETAILS_CHANGED',
					player: SM.PlayerIds.getPlayerId(player.ids),
					details,
					newUsername,
					...base,
				} satisfies SE.PlayerDetailsChanged
			}
		}
	}
	if (emittedEvent) {
		yield {
			id: Gen.next(state.counters.eventId),
			type: 'TEAMS_POLLED_UPDATE',
			matchId: state.currentMatch.historyEntryId,
			time: event.time,
		}
	}
}

function* emitLeaveSquadEvents(
	state: StateWithCurrentMatchAndPlayers,
	time: number,
	player: SM.Player,
	squadUniqueId: number,
): Generator<SE.Event> {
	if (player.squadId) {
		yield {
			type: 'PLAYER_LEFT_SQUAD',
			id: Gen.next(state.counters.eventId),
			player: SM.PlayerIds.getPlayerId(player.ids),
			uniqueId: squadUniqueId,
			time,
			matchId: state.currentMatch.historyEntryId,
		}
		let otherPlayerCount = 0
		for (const otherPlayer of state.currTeams.players) {
			if (SM.Squads.idsEqual(otherPlayer, player) && !SM.PlayerIds.match(player.ids, otherPlayer.ids)) {
				break
			}
			otherPlayerCount++
		}
		if (otherPlayerCount === 0) {
			yield {
				type: 'SQUAD_DISBANDED',
				id: Gen.next(state.counters.eventId),
				uniqueId: squadUniqueId,
				time,
				matchId: state.currentMatch.historyEntryId,
			}
		} else if (otherPlayerCount === 1) {
			if (player.isLeader) {
				yield {
					type: 'PLAYER_PROMOTED_TO_LEADER',
					id: Gen.next(state.counters.eventId),
					player: SM.PlayerIds.getPlayerId(player.ids),
					uniqueId: squadUniqueId,
					time,
					matchId: state.currentMatch.historyEntryId,
				}
			}
		}
	}
}

function initUniqueTeams(state: State, teams: SM.Teams) {
	const uniqueSquads: SM.UniqueSquad[] = teams.squads.map(s => ({
		...Obj.deepClone(s),
		uniqueId: Gen.next(state.counters.squadId),
	}))
	const uniqueTeams: SM.UniqueTeams = { ...teams, squads: Obj.deepClone(uniqueSquads) }
	return uniqueTeams
}
