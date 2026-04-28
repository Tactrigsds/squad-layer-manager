import * as Arr from '@/lib/array'
import * as Gen from '@/lib/generator'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import type * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import type * as MH from '@/models/match-history.models'
import type * as SE from '@/models/server-events.models'
import * as SM from '@/models/squad.models'

export type State = {
	lastKnownLogEventTime: number | null
	eventBufs: {
		rconEvents: (SM.RconEvents.Event & { id: number })[]
		logEvents: (SM.LogEvents.ParsedEvent & { id: number })[]
		lifecycleEvents: (
			| (Omit<SE.RconConnected, 'matchId' | 'reconnected'> & { currentLayerId: L.LayerId; nextLayerId: L.LayerId | null })
			| Omit<SE.RconDisconnected, 'matchId'>
		)[]
		teamsUpdates: { type: 'TEAMS_UPDATE'; id: number; teams: SM.Teams; time: number }[]
	}

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
	}
	log: CS.Logger
	hooks: {
		onNewGameDuringRoll: (newLayerId: L.LayerId, time: number) => Promise<{ match: MH.MatchDetails; nextLayerId: L.LayerId | null }>
		onNewGameDuringSync: (newLayerId: L.LayerId, time: number) => Promise<{ match: MH.MatchDetails; isNewMatch: boolean }>
	}

	debug__ticketOutcome?: { team1: number; team2: number }
}

type PendingEvent = State['eventBufs'][keyof State['eventBufs']][number]

export function init(
	opts: {
		currentMatch: State['currentMatch']
		hooks: State['hooks']
		counters: State['counters']
		log: State['log']
	},
): State {
	return {
		lastKnownLogEventTime: null,
		admins: new Set(),
		currTeams: null,
		expectedNewLayerId: null,
		eventBufs: {
			rconEvents: [],
			logEvents: [],
			lifecycleEvents: [],
			teamsUpdates: [],
		},
		nextLayerId: null,
		currentMatch: opts.currentMatch,
		syncState: { type: 'desynced' },
		counters: opts.counters,
		log: opts.log,
		hooks: opts.hooks,
		isFirstConnection: null,
	}
}

export function onRconConnected(state: State, time: number, nextLayerId: L.LayerId | null, currentLayerId: L.LayerId) {
	state.eventBufs.lifecycleEvents.push({
		type: 'RCON_CONNECTED',
		time,
		id: Gen.next(state.counters.eventId),
		currentLayerId,
		nextLayerId,
	})
}

export function onLogEvent(state: State, event: SM.LogEvents.ParsedEvent) {
	state.eventBufs.logEvents.push({ ...event, id: Gen.next(state.counters.eventId) })
}

export function onRconDisconnected(state: State, time: number) {
	state.eventBufs.lifecycleEvents.push({ type: 'RCON_DISCONNECTED', time, id: Gen.next(state.counters.eventId) })
}

export function onRconEvent(state: State, event: SM.RconEvents.Event) {
	state.eventBufs.rconEvents.push({ ...event, id: Gen.next(state.counters.eventId) })
}

export function onTeamsPolled(state: State, teams: SM.Teams, time: number) {
	const lastEvent = state.eventBufs.teamsUpdates.at(-1)
	if (!!lastEvent && lastEvent.time > time) {
		throw new Error(`Teams polled with time ${time} is older than last event time ${lastEvent.time}`)
	}
	state.eventBufs.teamsUpdates.push({ type: 'TEAMS_UPDATE', id: Gen.next(state.counters.eventId), teams, time })
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
		if (state.lastKnownLogEventTime == null || state.lastKnownLogEventTime < lifecycleEvt.time) continue
		Arr.insertIntoSorted(toProcess, lifecycleEvt, comparator)
	}

	for (const rconEvent of state.eventBufs.rconEvents) {
		// don't allow processing of non-log events unless we have at least one log event past the timestamp. this ensures that there are no latent log events yet to be processed. Note that all other event sources are assumed to have occured on reception, so there is no chance of latency there
		if (state.lastKnownLogEventTime == null || state.lastKnownLogEventTime < rconEvent.time) continue
		Arr.insertIntoSorted(toProcess, rconEvent, comparator)
	}

	for (const teamUpdateEvent of state.eventBufs.teamsUpdates) {
		if (state.lastKnownLogEventTime == null || state.lastKnownLogEventTime < teamUpdateEvent.time) continue
		Arr.insertIntoSorted(toProcess, teamUpdateEvent, comparator)
	}

	const processedEventIds = new Set<number>()
	loop: for (let i = 0; i < toProcess.length; i++) {
		const pendingEvent = toProcess[i]
		if (pendingEvent.type !== 'UNKNOWN') {
			log.debug('Attempting to process raw event %s (%s)', pendingEvent.type, pendingEvent.id, JSON.stringify(pendingEvent))
		}
		try {
			if (pendingEvent.time < time - 45_000) {
				state.log.warn('Skipping event %s (%s) as it is stale (%s)', pendingEvent.type, pendingEvent.id, pendingEvent.time)
				processedEventIds.add(pendingEvent.id)
				continue
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
						id: pendingEvent.id,
						matchId: state.currentMatch.historyEntryId,
					}
				}
			}

			if (pendingEvent.type === 'TEAMS_UPDATE' && state.syncState.type === 'syncing') {
				if (state.currentMatch === 'PENDING') throw new Error('Unexpected missing current match')
				state.currTeams = initUniqueTeams(state, pendingEvent.teams)

				if (state.syncState.isNewMatch) {
					yield {
						type: 'NEW_GAME',
						id: Gen.next(state.counters.eventId),
						layerId: state.currentMatch.layerId,
						matchId: state.currentMatch.historyEntryId,
						source: state.isFirstConnection ? 'slm-started' : 'rcon-reconnected',
						state: Obj.deepClone(state.currTeams),
						time: pendingEvent.time,
					}
				} else {
					yield {
						type: 'RESET',
						matchId: state.currentMatch.historyEntryId,
						state: Obj.deepClone(state.currTeams),
						time: pendingEvent.time,
						id: Gen.next(state.counters.eventId),
						source: state.isFirstConnection ? 'slm-started' : 'rcon-reconnected',
					}
				}
				state.syncState = { type: 'synced' }
			}

			if (
				pendingEvent.type === 'TEAMS_UPDATE' && state.syncState.type === 'rolling' && !!state.syncState.newGameEvent
				&& state.currentMatch !== 'PENDING'
			) {
				state.currTeams = initUniqueTeams(state, pendingEvent.teams)
				const event = state.syncState.newGameEvent
				yield {
					type: 'NEW_GAME',
					id: event.id,
					time: event.time,
					matchId: state.currentMatch.historyEntryId,
					layerId: state.currentMatch.layerId,
					state: Obj.deepClone(state.currTeams),
					source: 'new-game-detected',
				}
				state.syncState = { type: 'synced' }
			}

			if (pendingEvent.type === 'NEW_GAME') {
				if (pendingEvent.layerClassname === 'TransitionMap') {
					state.syncState = { type: 'rolling' }
					state.currTeams = null
					state.expectedNewLayerId = state.nextLayerId
				} else {
					state.syncState = { type: 'rolling', newGameEvent: pendingEvent }

					let newLayerId = state.expectedNewLayerId
					if (!newLayerId) throw new Error('expectedNewLayerId is null')
					if (!L.layerMatchesIngameLayerClassname(newLayerId, pendingEvent.layerClassname)) {
						throw new Error(`layerClassname mismatch: expected ${newLayerId}, got ${pendingEvent.layerClassname}`)
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
				continue loop
			}
			if (!state.currTeams) throw new Error('currTeams is null when synced')

			const base = {
				id: pendingEvent.id,
				matchId: state.currentMatch.historyEntryId,
				time: pendingEvent.time,
			}

			switch (pendingEvent.type) {
				case 'MAP_SET': {
					const layer = L.parseRawLayerText(`${pendingEvent.nextLayer} ${pendingEvent.nextFactions ?? ''}`.trim())
					if (!layer) {
						log.error(`Failed to parse layer text: ${pendingEvent.nextLayer} ${pendingEvent.nextFactions ?? ''}`)
						break
					}
					state.nextLayerId = layer.id
					yield {
						type: 'MAP_SET',
						...base,
						layerId: layer.id,
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

					yield {
						type: 'ROUND_ENDED',
						outcome,
						...base,
					}
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
					let username: string | undefined
					for (const teamUpdate of state.eventBufs.teamsUpdates) {
						username = SM.PlayerIds.find(teamUpdate.teams.players, p => p.ids, events.PLAYER_CONNECTED.playerIds)?.ids.username
						if (username) break
					}
					// suspend processing until we can find a username for this player that we can use(we don't get a full username with tags attached in the log chain)
					if (!username) {
						break loop
					}
					log.info(`Found username for player ${username}`)
					const player: SM.Player = {
						ids: {
							...events.PLAYER_CONNECTED.playerIds,
							...events.PLAYER_JOIN_SUCCEEDED.player,
							username,
						},
						teamId: events.PLAYER_ADDED_TO_TEAM?.teamId ?? 1,
						squadId: null,
						isLeader: false,
						isAdmin: state.admins.has(SM.PlayerIds.getPlayerId(events.PLAYER_CONNECTED.playerIds)),
						role: events.PLAYER_RESTARTED.deployRole,
					}

					state.currTeams.players.push(player)
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

					const squadKey = {
						teamId,
						squadId: pendingEvent.squadId,
						creator: SM.PlayerIds.getPlayerId(pendingEvent.creatorIds),
						uniqueId: Gen.next(state.counters.squadId),
					}
					const player = SM.PlayerIds.find(state.currTeams?.players, p => p.ids, pendingEvent.creatorIds)
					if (!player) {
						break
					}

					if (player.teamId !== teamId) {
						yield* changePlayerTeam(state, pendingEvent.time, player, teamId)
					}

					const prevSquadIndex = state.currTeams.squads.findIndex(s => SM.Squads.idsEqual(s, squadKey))
					if (prevSquadIndex !== -1) {
						yield* disbandSquad(state, pendingEvent.time, squadKey)
					}

					const squad = {
						...squadKey,
						squadName: pendingEvent.squadName,
						// will be updated later if incorrect
						locked: false,
					}

					state.currTeams.squads.push(squad)
					player.squadId = squad.squadId
					player.isLeader = true
					yield {
						type: 'SQUAD_CREATED',
						squad: Obj.deepClone(squad),
						...base,
					}

					break
				}

				case 'PLAYER_DISCONNECTED': {
					if (!state.currTeams) break
					const player = SM.PlayerIds.find(state.currTeams.players, p => p.ids, pendingEvent.playerIds)
					if (player) {
						if (player.squadId) yield* changeSquad(state, pendingEvent.time, player.ids, null)
						state.currTeams.players = state.currTeams.players.filter(p => !SM.PlayerIds.match(p.ids, pendingEvent.playerIds))
					} else {
						log.warn(`Player not found on disconnect: ${SM.PlayerIds.prettyPrint(pendingEvent.playerIds)}`)
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
					const nextTeams = pendingEvent.teams
					state.currTeams = Obj.deepClone(state.currTeams)
					for (const player of nextTeams.players) {
						const prevPlayer = SM.PlayerIds.find(state.currTeams.players, p => p.ids, player.ids)
						if (!prevPlayer) continue
						if (player.teamId !== prevPlayer.teamId) {
							yield* changePlayerTeam(state, pendingEvent.time, prevPlayer, player.teamId)
							if (player.squadId !== null) {
								yield* changeSquad(state, pendingEvent.time, player.ids, player.squadId)
							}
						} else if (player.squadId !== prevPlayer.squadId) {
							// disbanding squads handled here
							yield* changeSquad(state, pendingEvent.time, prevPlayer.ids, player.squadId)
						}

						if (player.isLeader && !prevPlayer.isLeader) {
							// all promotions and demotions are paired off so this should handle all cases
							yield* promotePlayerToLeader(state, pendingEvent.time, prevPlayer.ids)
						}

						const details = Obj.selectProps(player, SM.PLAYER_DETAILS)
						const prevDetails = Obj.selectProps(prevPlayer, SM.PLAYER_DETAILS)
						if (!Obj.deepEqual(details, prevDetails)) {
							for (const prop of SM.PLAYER_DETAILS) {
								// @ts-expect-error idgaf
								prevPlayer[prop] = player[prop]
							}
							yield {
								type: 'PLAYER_DETAILS_CHANGED',
								player: SM.PlayerIds.getPlayerId(player.ids),
								id: Gen.next(state.counters.eventId),
								details,
								time: pendingEvent.time,
								matchId: state.currentMatch.historyEntryId,
							}
						}
					}
					for (const squad of nextTeams.squads) {
						const prevSquad = state.currTeams.squads.find(s => SM.Squads.idsEqual(s, squad))
						if (!prevSquad) {
							log.debug(`squad ${SM.Squads.printKey(squad)} not found`)
							continue
						}
						const details = Obj.selectProps(squad, SM.SQUAD_DETAILS)
						const prevDetails = Obj.selectProps(prevSquad, SM.SQUAD_DETAILS)

						if (!Obj.deepEqual(details, prevDetails)) {
							for (const prop of SM.SQUAD_DETAILS) {
								prevSquad[prop] = squad[prop]
							}
							yield {
								type: 'SQUAD_DETAILS_CHANGED',
								uniqueId: prevSquad.uniqueId,
								id: Gen.next(state.counters.eventId),
								details,
								time: pendingEvent.time,
								matchId: state.currentMatch.historyEntryId,
							}
						}
					}
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
						from: pendingEvent.from,
						...base,
					}
					break
				}
			}

			processedEventIds.add(pendingEvent.id)
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

function* disbandSquad(state: State, time: number, key: SM.Squads.Key): Generator<SE.Event> {
	if (!state.currTeams) throw new Error(`currTeams is null, cannot process squad disbandment`)
	if (state.currentMatch === 'PENDING') throw new Error(`Cannot disband squad in PENDING match state`)
	const prevSquadIndex = state.currTeams.squads.findIndex(s => SM.Squads.idsEqual(s, key))
	if (prevSquadIndex === -1) return

	const squad = state.currTeams.squads[prevSquadIndex]!
	state.currTeams.squads.splice(prevSquadIndex, 1)
	for (const player of state.currTeams.players) {
		if (SM.Squads.idsEqual(player, key)) {
			yield {
				type: 'PLAYER_LEFT_SQUAD',
				player: SM.PlayerIds.getPlayerId(player.ids),
				id: Gen.next(state.counters.eventId),
				uniqueId: squad.uniqueId,
				time,
				matchId: state.currentMatch.historyEntryId,
			}
		}
	}
	state.currTeams.players = state.currTeams.players.filter(p => !SM.Squads.idsEqual(p, key))
	yield {
		type: 'SQUAD_DISBANDED',
		uniqueId: squad.uniqueId,
		id: Gen.next(state.counters.eventId),
		time,
		matchId: state.currentMatch.historyEntryId,
	}
}

function* changePlayerTeam(state: State, time: number, player: SM.Player, newTeamId: SM.TeamId | null): Generator<SE.Event> {
	if (!state.currTeams) throw new Error(`currTeams is null, cannot process player team change`)
	if (state.currentMatch === 'PENDING') throw new Error(`Cannot change player team in PENDING match state`)
	if (player.teamId === newTeamId) return
	if (player.squadId) yield* changeSquad(state, time, player.ids, null)
	player.teamId = newTeamId
	yield {
		type: 'PLAYER_CHANGED_TEAM',
		id: Gen.next(state.counters.eventId),
		player: SM.PlayerIds.getPlayerId(player.ids),
		newTeamId,
		time,
		matchId: state.currentMatch.historyEntryId,
	}
}

function* changeSquad(
	state: State,
	time: number,
	playerId: SM.PlayerIds.IdQueryOrPlayerId,
	newSquadId: number | null,
): Generator<SE.Event> {
	const log = state.log
	if (!state.currTeams) throw new Error(`currTeams is null, cannot process player leave squad`)
	if (state.currentMatch === 'PENDING') throw new Error(`Cannot leave squad in PENDING match state`)
	const player = state.currTeams.players.find(p => SM.PlayerIds.match(p.ids, playerId))
	if (!player) return
	if (player.squadId === newSquadId) return
	if (player.squadId !== null) {
		const squad = state.currTeams.squads.find(squad => SM.Squads.idsEqual(squad, player))!
		if (!squad) {
			log.error(`No squad found for player squadId ${player.squadId} teamId ${player.teamId}`)
			return
		}
		player.squadId = null
		yield {
			type: 'PLAYER_LEFT_SQUAD',
			id: Gen.next(state.counters.eventId),
			player: SM.PlayerIds.getPlayerId(player.ids),
			uniqueId: squad?.uniqueId,
			time,
			matchId: state.currentMatch.historyEntryId,
		}
		const remainingPlayers = state.currTeams.players.filter(p => SM.Squads.idsEqual(p, squad))
		if (remainingPlayers.length === 0) {
			yield* disbandSquad(state, time, squad)
		} else if (remainingPlayers.length === 1 && player.isLeader) {
			// this is the only case where we can promote the player to leader because we have no way of knowing what the FTLs are
			yield* promotePlayerToLeader(state, time, remainingPlayers[0].ids)
		}
	}

	if (newSquadId !== null) {
		const squad = state.currTeams.squads.find(s => s.squadId === newSquadId && s.teamId === player.teamId)!
		if (!squad) {
			log.error(`No squad found for squadId ${newSquadId}`)
			return
		}
		player.squadId = newSquadId
		yield {
			type: 'PLAYER_JOINED_SQUAD',
			id: Gen.next(state.counters.eventId),
			player: SM.PlayerIds.getPlayerId(player.ids),
			uniqueId: squad.uniqueId,
			time,
			matchId: state.currentMatch.historyEntryId,
		}
	}
}

function* promotePlayerToLeader(state: State, time: number, _playerIds: SM.PlayerIds.IdQueryOrPlayerId): Generator<SE.Event> {
	const log = state.log
	const playerIds = SM.PlayerIds.normalizeIdQuery(_playerIds)
	if (!state.currTeams || state.currentMatch === 'PENDING') return
	const player = state.currTeams.players.find(p => SM.PlayerIds.match(p.ids, playerIds))
	if (!player) return
	if (player.isLeader) {
		log.error(`Player ${SM.PlayerIds.prettyPrint(playerIds)} is already a squad leader`)
		return
	}
	const playerSquad = state.currTeams.squads.find(squad => SM.Squads.idsEqual(squad, player))!
	for (const otherPlayer of state.currTeams.players) {
		if (otherPlayer.isLeader && SM.Squads.idsEqual(playerSquad, otherPlayer) && !SM.PlayerIds.match(player.ids, otherPlayer.ids)) {
			otherPlayer.isLeader = false
		}
	}
	player.isLeader = true
	yield {
		type: 'PLAYER_PROMOTED_TO_LEADER',
		id: Gen.next(state.counters.eventId),
		player: SM.PlayerIds.getPlayerId(player.ids),
		time,
		matchId: state.currentMatch.historyEntryId,
		uniqueId: playerSquad.uniqueId,
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
