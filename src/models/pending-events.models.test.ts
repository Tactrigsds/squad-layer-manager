import * as Gen from '@/lib/generator'
import type * as CS from '@/models/context-shared'
import type * as L from '@/models/layer'
import type * as MH from '@/models/match-history.models'
import * as PendingEvents from '@/models/pending-events.models'
import type * as SE from '@/models/server-events.models'
import type * as SM from '@/models/squad.models'
import { describe, expect, it, vi } from 'vitest'

// --- Layer IDs (from layer.test.ts) ---
// Gorodok_RAAS_v1, Faction_1=RGF ('Russian Ground Forces'), Faction_2=ADF ('Australian Defence Force')
const LAYER_A = 'RAW:Gorodok_RAAS_v1 RGF+CombinedArms ADF+Mechanized' as L.LayerId
const LAYER_A_CLASSNAME = 'Gorodok_RAAS_v1'
// Narva_RAAS_v1, Faction_1=CAF, Faction_2=RGF

// --- Helpers ---

function makeLog(): CS.Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
		child: vi.fn(),
	} as unknown as CS.Logger
}

function makeMatchDetails(historyEntryId: number, layerId: L.LayerId): MH.MatchDetails {
	return {
		historyEntryId,
		layerId,
		status: 'in-progress',
		ordinal: 1,
		serverId: 'test',
		isCurrentMatch: true,
		createdAt: null,
	} as unknown as MH.MatchDetails
}

function makeState(opts: {
	currentMatch?: PendingEvents.State['currentMatch']
	matchId?: number
	layerId?: L.LayerId
	isNewMatch?: boolean
} = {}): { state: PendingEvents.State; hooks: PendingEvents.State['hooks'] } {
	const hooks: PendingEvents.State['hooks'] = {
		onNewGameDuringSync: vi.fn().mockResolvedValue({
			match: makeMatchDetails(opts.matchId ?? 1, opts.layerId ?? LAYER_A),
			isNewMatch: opts.isNewMatch ?? true,
		}),
		onNewGameDuringRoll: vi.fn().mockResolvedValue({
			match: makeMatchDetails(opts.matchId ?? 2, opts.layerId ?? LAYER_A),
			nextLayerId: opts.layerId ?? LAYER_A,
		}),
		fetchLayersStatus: () => Promise.resolve(null),
	}
	const state = PendingEvents.init({
		currentMatch: opts.currentMatch ?? 'PENDING',
		counters: { eventId: Gen.counter(), squadId: Gen.counter() },
		log: makeLog(),
		hooks,
	})
	return { state, hooks }
}

async function collect(state: PendingEvents.State): Promise<SE.Event[]> {
	const events: SE.Event[] = []
	for await (const event of PendingEvents.process(state, 0)) {
		events.push(event)
	}
	return events
}

function makePlayer(eos: string, teamId: SM.TeamId, opts: Partial<SM.Player> = {}): SM.Player {
	return {
		ids: { eos, playerController: `ctrl_${eos}`, username: eos },
		teamId,
		squadId: null,
		isLeader: false,
		isAdmin: false,
		role: 'Rifleman_01',
		...opts,
	}
}

function makeSquad(squadId: number, teamId: SM.TeamId, creatorEos: string, uniqueId: number): SM.UniqueSquad {
	return { squadId, teamId, creator: creatorEos, uniqueId, squadName: `Squad ${squadId}`, locked: false }
}

function makeTeams(players: SM.Player[] = [], squads: SM.Squad[] = []): SM.Teams {
	return { players, squads }
}

function makeUnknownLogEvent(time: number): SM.LogEvents.NonChainEvent {
	return { type: 'UNKNOWN', time, chainID: 0, raw: '' }
}

function makeRoundEndedChain(
	time: number,
	winner: { team: SM.TeamId; tickets: number; faction: string; unit: string },
	loser: { team: SM.TeamId; tickets: number; faction: string; unit: string },
): SM.LogEvents.AnyChainEvent {
	return {
		type: 'ROUND_ENDED_CHAIN',
		time,
		// @ts-expect-error idgaf
		events: {
			DETERMINE_MATCH_WINNER: { type: 'DETERMINE_MATCH_WINNER', time, chainID: 0, raw: '', winner: winner.unit, map: 'Gorodok' },
			ROUND_DECIDED_WINNER: {
				type: 'ROUND_DECIDED_WINNER',
				time,
				chainID: 0,
				raw: '',
				...winner,
				layer: 'Gorodok_RAAS_v1',
				map: 'Gorodok',
			},
			ROUND_DECIDED_LOSER: { type: 'ROUND_DECIDED_LOSER', time, chainID: 0, raw: '', ...loser, layer: 'Gorodok_RAAS_v1', map: 'Gorodok' },
		},
	}
}

function makePlayerConnectedChain(time: number, eos: string, controller: string, teamId: SM.TeamId): SM.LogEvents.AnyChainEvent {
	return {
		type: 'PLAYER_CONNECTED_CHAIN',
		time,
		events: {
			PLAYER_CONNECTED: {
				type: 'PLAYER_CONNECTED',
				time,
				chainID: 549,
				raw: '',
				playerIds: { eos, playerController: controller },
				ip: '1.2.3.4',
			},
			PLAYER_JOIN_SUCCEEDED: { type: 'PLAYER_JOIN_SUCCEEDED', time, chainID: 549, raw: '', player: { usernameNoTag: 'Test Player' } },
			PLAYER_ADDED_TO_TEAM: { type: 'PLAYER_ADDED_TO_TEAM', time, chainID: 549, raw: '', playerIds: { username: 'Test Player' }, teamId },
		},
	}
}

// Advances state to synced via RCON_CONNECTED + TEAMS_UPDATE, returns the yielded events
async function syncUp(
	state: PendingEvents.State,
	opts: { layerId?: L.LayerId; teams?: SM.Teams } = {},
): Promise<SE.Event[]> {
	const layerId = opts.layerId ?? LAYER_A
	const teams = opts.teams ?? makeTeams()
	PendingEvents.onRconConnected(state, 100, layerId, layerId)
	PendingEvents.onLogEvent(state, makeUnknownLogEvent(101))
	PendingEvents.onTeamsPolled(state, teams, 100)
	const firstBatch = await collect(state) // RCON_CONNECTED + MAP_SET fire; TEAMS_UPDATE held (no log yet)
	return [...firstBatch]
}

// --- Tests ---

describe('PendingEvents', () => {
	describe('sync flow', () => {
		it('first connection: yields RCON_CONNECTED, MAP_SET, then NEW_GAME with source=slm-started', async () => {
			const { state } = makeState()
			const events = await syncUp(state)
			expect(events).toHaveLength(3)
			expect(events[0]).toMatchObject({ type: 'RCON_CONNECTED' })
			expect(events[1]).toMatchObject({ type: 'MAP_SET' })
			expect(events[2]).toMatchObject({ type: 'NEW_GAME', source: 'slm-started' })
		})

		it('second connection: NEW_GAME has source=rcon-reconnected', async () => {
			const { state } = makeState()
			await syncUp(state) // first connection: isFirstConnection becomes true
			PendingEvents.onRconDisconnected(state, 200)
			await collect(state)
			const events = await syncUp(state) // second: isFirstConnection becomes false
			expect(events.find(e => e.type === 'NEW_GAME')).toMatchObject({ source: 'rcon-reconnected' })
		})

		it('same-match reconnect: yields RESET instead of NEW_GAME', async () => {
			const { state } = makeState({ isNewMatch: false })
			const events = await syncUp(state)
			expect(events.find(e => e.type === 'RESET')).toBeDefined()
			expect(events.find(e => e.type === 'NEW_GAME')).toBeUndefined()
		})

		it('NEW_GAME carries the teams state from TEAMS_UPDATE', async () => {
			const { state } = makeState()
			const p1 = makePlayer('eos-001', 1)
			const events = await syncUp(state, { teams: makeTeams([p1]) })
			const newGame = events.find(e => e.type === 'NEW_GAME') as SE.NewGame
			expect(newGame.state.players).toHaveLength(1)
			expect(newGame.state.players[0]).toMatchObject({ ids: { eos: 'eos-001' } })
		})

		it('RCON_CONNECTED is skipped when syncState is rolling', async () => {
			const { state } = makeState()
			await syncUp(state)
			// Simulate a TransitionMap new-game log event to enter rolling
			PendingEvents.onLogEvent(state, {
				type: 'NEW_GAME',
				time: 200,
				chainID: 0,
				raw: '',
				mapClassname: 'Transition',
				layerClassname: 'TransitionMap',
			})
			await collect(state)
			expect(state.syncState.type).toBe('rolling')

			// RCON_CONNECTED while rolling should be ignored
			PendingEvents.onRconConnected(state, 300, LAYER_A, LAYER_A)
			const events = await collect(state)
			expect(events).toHaveLength(0)
			expect(state.syncState.type).toBe('rolling')
		})
	})

	describe('RCON_DISCONNECTED', () => {
		it('yields RCON_DISCONNECTED, clears currTeams, and resets syncState to desynced', async () => {
			const { state } = makeState()
			await syncUp(state)
			expect(state.syncState.type).toBe('synced')

			PendingEvents.onRconDisconnected(state, 200)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const events = await collect(state)
			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'RCON_DISCONNECTED' })
			expect(state.syncState.type).toBe('desynced')
			expect(state.currTeams).toBeNull()
		})

		it('does not yield RCON_DISCONNECTED if currentMatch is PENDING', async () => {
			const { state } = makeState()
			// never synced, so currentMatch stays PENDING
			PendingEvents.onRconDisconnected(state, 100)
			const events = await collect(state)
			expect(events).toHaveLength(0)
		})

		it('does not change syncState to desynced if rolling', async () => {
			const { state } = makeState()
			await syncUp(state)
			PendingEvents.onLogEvent(state, {
				type: 'NEW_GAME',
				time: 200,
				chainID: 0,
				raw: '',
				mapClassname: 'Transition',
				layerClassname: 'TransitionMap',
			})
			await collect(state)
			expect(state.syncState.type).toBe('rolling')

			PendingEvents.onRconDisconnected(state, 300)
			await collect(state)
			expect(state.syncState.type).toBe('rolling')
		})
	})

	describe('full server roll sequence', () => {
		it('ROUND_ENDED → TransitionMap → new layer + TEAMS_UPDATE → NEW_GAME(server-roll)', async () => {
			const { state } = makeState({ layerId: LAYER_A })
			const p1 = makePlayer('eos-001', 1, { squadId: 1, isLeader: true })
			const p2 = makePlayer('eos-002', 1, { squadId: 1 })
			const squad = makeSquad(1, 1, 'eos-001', 100)
			await syncUp(state, { layerId: LAYER_A, teams: makeTeams([p1, p2], [squad]) })
			state.currTeams!.squads[0].uniqueId = 100
			state.nextLayerId = LAYER_A

			// 1. Round ends
			PendingEvents.onLogEvent(
				state,
				makeRoundEndedChain(200, { team: 1, tickets: 300, faction: 'RGF', unit: 'CombinedArms' }, {
					team: 2,
					tickets: 150,
					faction: 'ADF',
					unit: 'Mechanized',
				}),
			)
			const batch1 = await collect(state)
			expect(batch1.map(e => e.type)).toEqual(['ROUND_ENDED'])

			// 2. Server transitions — TransitionMap NEW_GAME enters rolling, clears teams
			PendingEvents.onLogEvent(state, {
				type: 'NEW_GAME',
				time: 300,
				chainID: 0,
				raw: '',
				mapClassname: 'Transition',
				layerClassname: 'TransitionMap',
			})
			const batch2 = await collect(state)
			expect(batch2).toHaveLength(0)
			expect(state.syncState.type).toBe('rolling')
			expect(state.currTeams).toBeNull()

			// 3. Actual layer loads — non-TransitionMap NEW_GAME is buffered, no event yet (waiting for TEAMS_UPDATE)
			PendingEvents.onLogEvent(state, {
				type: 'NEW_GAME',
				time: 400,
				chainID: 0,
				raw: '',
				mapClassname: 'Gorodok',
				layerClassname: LAYER_A_CLASSNAME,
			})
			const batch3 = await collect(state)
			expect(batch3).toHaveLength(0)
			expect(state.syncState).toMatchObject({ type: 'rolling', newGameEvent: expect.objectContaining({ type: 'NEW_GAME' }) })

			// 4. TEAMS_UPDATE arrives — triggers NEW_GAME with source=server-roll
			const newPlayers = [makePlayer('eos-new', 1)]
			PendingEvents.onTeamsPolled(state, makeTeams(newPlayers), 401)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(402))
			const batch4 = await collect(state)

			expect(batch4).toHaveLength(1)
			const newGame = batch4[0] as SE.NewGame
			expect(newGame).toMatchObject({ type: 'NEW_GAME', source: 'server-roll' })
			expect(newGame.state.players).toHaveLength(1)
			expect(newGame.state.players[0]).toMatchObject({ ids: { eos: 'eos-new' } })
			expect(state.syncState.type).toBe('synced')
		})
	})

	describe('rolling / server-roll flow', () => {
		it('TransitionMap NEW_GAME sets rolling and clears teams', async () => {
			const { state } = makeState()
			await syncUp(state, { teams: makeTeams([makePlayer('eos-001', 1)]) })
			expect(state.currTeams?.players).toHaveLength(1)

			PendingEvents.onLogEvent(state, {
				type: 'NEW_GAME',
				time: 200,
				chainID: 0,
				raw: '',
				mapClassname: 'Transition',
				layerClassname: 'TransitionMap',
			})
			await collect(state)

			expect(state.syncState.type).toBe('rolling')
			expect(state.currTeams).toBeNull()
		})

		it('non-TransitionMap NEW_GAME + TEAMS_UPDATE yields NEW_GAME with source=server-roll', async () => {
			const { state } = makeState({ layerId: LAYER_A })
			await syncUp(state, { layerId: LAYER_A })

			// TransitionMap first (sets expectedNewLayerId = nextLayerId)
			state.nextLayerId = LAYER_A
			PendingEvents.onLogEvent(state, {
				type: 'NEW_GAME',
				time: 200,
				chainID: 0,
				raw: '',
				mapClassname: 'Transition',
				layerClassname: 'TransitionMap',
			})
			await collect(state)

			// Actual layer transition
			PendingEvents.onLogEvent(state, {
				type: 'NEW_GAME',
				time: 300,
				chainID: 0,
				raw: '',
				mapClassname: 'Gorodok',
				layerClassname: LAYER_A_CLASSNAME,
			})
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-new', 1)]), 400)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(500))
			const events = await collect(state)

			const newGame = events.find(e => e.type === 'NEW_GAME') as SE.NewGame | undefined
			expect(newGame).toBeDefined()
			expect(newGame!.source).toBe('server-roll')
			expect(newGame!.state.players).toHaveLength(1)
		})
	})

	describe('rcon event timing', () => {
		it('rcon events are held until a log event advances the clock past their timestamp', async () => {
			const { state } = makeState()
			await syncUp(state)

			const squadCreatedEvent: SM.RconEvents.Event = {
				type: 'SQUAD_CREATED',
				time: 200,
				squadId: 1,
				squadName: 'Alpha',
				teamName: 'Russian Ground Forces',
				creatorIds: { eos: 'eos-001', playerController: 'ctrl_eos-001', username: 'eos-001' },
			}
			state.currTeams!.players.push(makePlayer('eos-001', 1))
			PendingEvents.onRconEvent(state, squadCreatedEvent)

			// No log event at t>=200 yet — rcon event should not fire
			const batch1 = await collect(state)
			expect(batch1).toHaveLength(0)
			expect(state.eventBufs.rconEmittedEvents).toHaveLength(1)

			// Add a log event past t=200
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const batch2 = await collect(state)
			expect(batch2).toHaveLength(1)
			expect(batch2[0]).toMatchObject({ type: 'SQUAD_CREATED' })
			expect(state.eventBufs.rconEmittedEvents).toHaveLength(0)
		})
	})

	describe('ROUND_ENDED_CHAIN', () => {
		it('yields ROUND_ENDED with team1 outcome when team1 wins', async () => {
			const { state } = makeState()
			await syncUp(state)

			PendingEvents.onLogEvent(
				state,
				makeRoundEndedChain(200, { team: 1, tickets: 300, faction: 'RGF', unit: 'CombinedArms' }, {
					team: 2,
					tickets: 150,
					faction: 'ADF',
					unit: 'Mechanized',
				}),
			)
			const events = await collect(state)

			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({
				type: 'ROUND_ENDED',
				outcome: { type: 'team1', team1Tickets: 300, team2Tickets: 150 },
			})
		})

		it('yields ROUND_ENDED with team2 outcome when team2 wins', async () => {
			const state = makeSyncedState([], [])

			PendingEvents.onLogEvent(
				state,
				makeRoundEndedChain(200, { team: 2, tickets: 250, faction: 'ADF', unit: 'Mechanized' }, {
					team: 1,
					tickets: 100,
					faction: 'RGF',
					unit: 'CombinedArms',
				}),
			)
			const events = await collect(state)

			expect(events[0]).toMatchObject({
				type: 'ROUND_ENDED',
				outcome: { type: 'team2', team1Tickets: 100, team2Tickets: 250 },
			})
		})

		it('debug__ticketOutcome overrides ROUND_DECIDED data and is deleted after processing', async () => {
			const state = makeSyncedState([], [])

			state.debug__ticketOutcome = { team1: 400, team2: 200 }

			PendingEvents.onLogEvent(
				state,
				makeRoundEndedChain(200, { team: 2, tickets: 999, faction: 'ADF', unit: 'Mechanized' }, {
					team: 1,
					tickets: 0,
					faction: 'RGF',
					unit: 'CombinedArms',
				}),
			)
			const events = await collect(state)

			expect(events[0]).toMatchObject({
				type: 'ROUND_ENDED',
				outcome: { type: 'team1', team1Tickets: 400, team2Tickets: 200 },
			})
			expect(state.debug__ticketOutcome).toBeUndefined()
		})

		it('debug__ticketOutcome yields draw when ticket counts are equal', async () => {
			const state = makeSyncedState([], [])

			state.debug__ticketOutcome = { team1: 200, team2: 200 }

			PendingEvents.onLogEvent(
				state,
				makeRoundEndedChain(200, { team: 1, tickets: 200, faction: 'RGF', unit: 'CombinedArms' }, {
					team: 2,
					tickets: 200,
					faction: 'ADF',
					unit: 'Mechanized',
				}),
			)
			const events = await collect(state)

			expect(events[0]).toMatchObject({ type: 'ROUND_ENDED', outcome: { type: 'draw' } })
		})
	})

	describe('PLAYER_CONNECTED_CHAIN', () => {
		it('adds the player to currTeams and yields PLAYER_CONNECTED immediately', async () => {
			const { state } = makeState()
			await syncUp(state)

			PendingEvents.onLogEvent(state, makePlayerConnectedChain(300, 'eos-001', 'ctrl-001', 1))
			const events = await collect(state)

			const connected = events.find(e => e.type === 'PLAYER_CONNECTED') as SE.PlayerConnected
			expect(connected).toBeDefined()
			expect(connected.player).toMatchObject({ ids: expect.objectContaining({ eos: 'eos-001', username: 'Test Player' }), teamId: 1 })
			expect(state.currTeams?.players.find(p => p.ids.eos === 'eos-001')).toBeDefined()
		})

		it('marks player as admin if their eos id is in admins set', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1)], [])

			state.admins.add('eos-001')

			PendingEvents.onLogEvent(state, makePlayerConnectedChain(300, 'eos-001', 'ctrl-001', 1))
			const events = await collect(state)

			const connected = events.find(e => e.type === 'PLAYER_CONNECTED') as SE.PlayerConnected
			expect(connected.player.isAdmin).toBe(true)
		})
	})

	describe('PLAYER_DISCONNECTED', () => {
		it('removes player from currTeams and yields PLAYER_DISCONNECTED', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1)], [])

			PendingEvents.onLogEvent(state, {
				type: 'PLAYER_DISCONNECTED',
				time: 200,
				chainID: 0,
				raw: '',
				playerIds: { eos: 'eos-001', playerController: 'ctrl_eos-001' },
				ip: '1.2.3.4',
			})
			const events = await collect(state)

			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'PLAYER_DISCONNECTED' })
			expect(state.currTeams?.players).toHaveLength(0)
		})

		it('yields PLAYER_LEFT_SQUAD before PLAYER_DISCONNECTED when player is in a squad', async () => {
			const p1 = makePlayer('eos-001', 1, { squadId: 1 })
			const squad = makeSquad(1, 1, 'eos-001', 100)
			const state = makeSyncedState([p1], [squad])

			// Patch uniqueId onto state
			state.currTeams!.squads[0].uniqueId = 100

			PendingEvents.onLogEvent(state, {
				type: 'PLAYER_DISCONNECTED',
				time: 200,
				chainID: 0,
				raw: '',
				playerIds: { eos: 'eos-001', playerController: 'ctrl_eos-001' },
				ip: '1.2.3.4',
			})
			const events = await collect(state)

			const types = events.map(e => e.type)
			expect(types).toContain('PLAYER_LEFT_SQUAD')
			expect(types).toContain('PLAYER_DISCONNECTED')
		})
	})

	describe('SQUAD_CREATED (rcon)', () => {
		it('creates squad, updates player.squadId, yields SQUAD_CREATED', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1)], [])

			PendingEvents.onRconEvent(state, {
				type: 'SQUAD_CREATED',
				time: 200,
				squadId: 1,
				squadName: 'Alpha',
				teamName: 'Russian Ground Forces',
				creatorIds: { eos: 'eos-001', playerController: 'ctrl_eos-001', username: 'eos-001' },
			})
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const events = await collect(state)

			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'SQUAD_CREATED', squad: expect.objectContaining({ squadName: 'Alpha', teamId: 1 }) })
			expect(state.currTeams?.squads).toHaveLength(1)
			expect(state.currTeams?.players[0].squadId).toBe(1)
		})

		it('resolves to team 2 when faction matches Faction_2', async () => {
			const state = makeSyncedState([makePlayer('eos-002', 2)], [])

			PendingEvents.onRconEvent(state, {
				type: 'SQUAD_CREATED',
				time: 200,
				squadId: 1,
				squadName: 'Bravo',
				teamName: 'Australian Defence Force',
				creatorIds: { eos: 'eos-002', playerController: 'ctrl_eos-002', username: 'eos-002' },
			})
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const events = await collect(state)

			expect(events[0]).toMatchObject({ type: 'SQUAD_CREATED', squad: expect.objectContaining({ teamId: 2 }) })
		})
	})

	describe('SQUAD_RENAMED (rcon)', () => {
		it('yields SQUAD_RENAMED with old and new names', async () => {
			const p1 = makePlayer('eos-001', 1)
			const squad = makeSquad(1, 1, 'eos-001', 100)
			const state = makeSyncedState([p1], [squad])

			PendingEvents.onRconEvent(state, {
				type: 'SQUAD_RENAMED',
				time: 200,
				squadId: 1,
				teamId: 1,
				oldSquadName: 'Alpha',
				newSquadName: 'Bravo',
			})
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const events = await collect(state)

			expect(events).toHaveLength(1)
			expect(events[0]).toMatchObject({ type: 'SQUAD_RENAMED', oldSquadName: 'Alpha', newSquadName: 'Bravo', uniqueId: 100 })
		})
	})

	describe('TEAMS_UPDATE reconciliation (synced)', () => {
		it('yields PLAYER_CHANGED_TEAM when a player switches teams', async () => {
			const p1 = makePlayer('eos-001', 1)
			const state = makeSyncedState([p1], [])

			const updatedTeams = makeTeams([makePlayer('eos-001', 2)])
			PendingEvents.onTeamsPolled(state, updatedTeams, 200)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const events = await collect(state)

			expect(events.some(e => e.type === 'PLAYER_CHANGED_TEAM')).toBe(true)
			expect(state.currTeams?.players[0].teamId).toBe(2)
		})

		it('yields PLAYER_LEFT_SQUAD + SQUAD_DISBANDED when a player leaves a squad and was the only member', async () => {
			const p1 = makePlayer('eos-001', 1, { squadId: 1 })
			const squad = makeSquad(1, 1, 'eos-001', 100)
			const state = makeSyncedState([p1], [squad])

			const updatedTeams = makeTeams([makePlayer('eos-001', 1, { squadId: null })], [])
			PendingEvents.onTeamsPolled(state, updatedTeams, 200)

			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const events = await collect(state)

			const types = events.map(e => e.type)
			expect(types).toContain('PLAYER_LEFT_SQUAD')
			expect(types).toContain('SQUAD_DISBANDED')
		})

		it('yields PLAYER_PROMOTED_TO_LEADER when player becomes leader', async () => {
			const p1 = makePlayer('eos-001', 1, { squadId: 1, isLeader: false })
			const squad = makeSquad(1, 1, 'eos-001', 100)
			const state = makeSyncedState([p1], [squad])

			const updatedTeams = makeTeams([makePlayer('eos-001', 1, { squadId: 1, isLeader: true })], [squad])
			PendingEvents.onTeamsPolled(state, updatedTeams, 200)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const events = await collect(state)

			expect(events.some(e => e.type === 'PLAYER_PROMOTED_TO_LEADER')).toBe(true)
		})

		it('yields PLAYER_DETAILS_CHANGED when role changes', async () => {
			const p1 = makePlayer('eos-001', 1, { role: 'Rifleman_01' })
			const state = makeSyncedState([p1], [])

			const updatedTeams = makeTeams([makePlayer('eos-001', 1, { role: 'Medic_01' })])
			PendingEvents.onTeamsPolled(state, updatedTeams, 200)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const events = await collect(state)

			expect(events.some(e => e.type === 'PLAYER_DETAILS_CHANGED')).toBe(true)
		})

		it('yields SQUAD_DETAILS_CHANGED when squad locked status changes', async () => {
			const squad = makeSquad(1, 1, 'eos-001', 100)
			const state = makeSyncedState([makePlayer('eos-001', 1, { squadId: 1 })], [squad])
			state.currTeams!.squads[0].uniqueId = 100

			const updatedSquad = { ...squad, locked: true }
			const updatedTeams = makeTeams(state.currTeams!.players, [updatedSquad])
			PendingEvents.onTeamsPolled(state, updatedTeams, 200)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const events = await collect(state)

			expect(events.some(e => e.type === 'SQUAD_DETAILS_CHANGED')).toBe(true)
		})
	})

	function makeSyncedState(players: SM.Player[], squads: SM.UniqueSquad[]) {
		const { state } = makeState()
		state.syncState = { type: 'synced' }
		state.currentMatch = { historyEntryId: 1, layerId: LAYER_A }
		state.currTeams = { players, squads }
		state.lastKnownLogEventTime = 1000
		return state
	}

	describe('TEAMS_UPDATE reconciliation (complex simultaneous changes)', () => {
		it('squad merge: leader and squadmate both leave squad1 and join squad2', async () => {
			const p1 = makePlayer('eos-001', 1, { squadId: 1, isLeader: true })
			const p2 = makePlayer('eos-002', 1, { squadId: 1 })
			const p3 = makePlayer('eos-003', 1, { squadId: 2, isLeader: true })
			const p4 = makePlayer('eos-004', 1, { squadId: 2 })
			const sq1 = makeSquad(1, 1, 'eos-001', 101)
			const sq2 = makeSquad(2, 1, 'eos-003', 102)
			const state = makeSyncedState([p1, p2, p3, p4], [sq1, sq2])

			PendingEvents.onTeamsPolled(
				state,
				makeTeams(
					[
						makePlayer('eos-001', 1, { squadId: 2 }),
						makePlayer('eos-002', 1, { squadId: 2 }),
						makePlayer('eos-003', 1, { squadId: 2, isLeader: true }),
						makePlayer('eos-004', 1, { squadId: 2 }),
					],
					[sq2],
				),
				500,
			)
			const events = await collect(state)

			const types = events.map(e => e.type)
			expect(types.filter(t => t === 'PLAYER_LEFT_SQUAD')).toHaveLength(2)
			expect(types.filter(t => t === 'PLAYER_JOINED_SQUAD')).toHaveLength(2)
			expect(types.filter(t => t === 'SQUAD_DISBANDED')).toHaveLength(1)

			expect(state.currTeams!.squads).toHaveLength(1)
			expect(state.currTeams!.squads[0].uniqueId).toBe(102)
			expect(state.currTeams!.players.filter(p => p.squadId === 2)).toHaveLength(4)
		})

		it('two solo players switch teams simultaneously, each disbanding their own squad', async () => {
			const p1 = makePlayer('eos-001', 1, { squadId: 1, isLeader: true })
			const p2 = makePlayer('eos-002', 1, { squadId: 2, isLeader: true })
			const sq1 = makeSquad(1, 1, 'eos-001', 101)
			const sq2 = makeSquad(2, 1, 'eos-002', 102)
			const state = makeSyncedState([p1, p2], [sq1, sq2])

			PendingEvents.onTeamsPolled(
				state,
				makeTeams(
					[makePlayer('eos-001', 2), makePlayer('eos-002', 2)],
					[],
				),
				500,
			)
			const events = await collect(state)

			const types = events.map(e => e.type)
			expect(types.filter(t => t === 'PLAYER_LEFT_SQUAD')).toHaveLength(2)
			expect(types.filter(t => t === 'SQUAD_DISBANDED')).toHaveLength(2)
			expect(types.filter(t => t === 'PLAYER_CHANGED_TEAM')).toHaveLength(2)

			expect(state.currTeams!.squads).toHaveLength(0)
			expect(state.currTeams!.players.every(p => p.teamId === 2)).toBe(true)
		})

		it('simultaneous leader succession in two squads', async () => {
			const p1 = makePlayer('eos-001', 1, { squadId: 1, isLeader: true })
			const p2 = makePlayer('eos-002', 1, { squadId: 1 })
			const p3 = makePlayer('eos-003', 1, { squadId: 2, isLeader: true })
			const p4 = makePlayer('eos-004', 1, { squadId: 2 })
			const sq1 = makeSquad(1, 1, 'eos-001', 101)
			const sq2 = makeSquad(2, 1, 'eos-003', 102)
			const state = makeSyncedState([p1, p2, p3, p4], [sq1, sq2])

			PendingEvents.onTeamsPolled(
				state,
				makeTeams(
					[
						makePlayer('eos-001', 1),
						makePlayer('eos-002', 1, { squadId: 1, isLeader: true }),
						makePlayer('eos-003', 1),
						makePlayer('eos-004', 1, { squadId: 2, isLeader: true }),
					],
					[sq1, sq2],
				),
				500,
			)
			const events = await collect(state)

			const types = events.map(e => e.type)
			expect(types.filter(t => t === 'PLAYER_LEFT_SQUAD')).toHaveLength(2)
			expect(types.filter(t => t === 'PLAYER_PROMOTED_TO_LEADER')).toHaveLength(2)
			expect(types.filter(t => t === 'SQUAD_DISBANDED')).toHaveLength(0)

			expect(state.currTeams!.squads).toHaveLength(2)
			expect(state.currTeams!.players.find(p => p.ids.eos === 'eos-002')!.isLeader).toBe(true)
			expect(state.currTeams!.players.find(p => p.ids.eos === 'eos-004')!.isLeader).toBe(true)
		})

		it('mixed: team switch triggers squad disband with mid-process leader succession, plus role change on another player', async () => {
			const p1 = makePlayer('eos-001', 1, { squadId: 1, isLeader: true })
			const p2 = makePlayer('eos-002', 1, { squadId: 1, role: 'Medic_01' })
			const p3 = makePlayer('eos-003', 2)
			const sq1 = makeSquad(1, 1, 'eos-001', 101)
			const state = makeSyncedState([p1, p2, p3], [sq1])

			PendingEvents.onTeamsPolled(
				state,
				makeTeams(
					[
						makePlayer('eos-001', 2),
						makePlayer('eos-002', 1, { role: 'Rifleman_01' }),
						makePlayer('eos-003', 2),
					],
					[],
				),
				500,
			)
			const events = await collect(state)

			const types = events.map(e => e.type)
			expect(types.filter(t => t === 'PLAYER_LEFT_SQUAD')).toHaveLength(2)
			expect(types.filter(t => t === 'PLAYER_CHANGED_TEAM')).toHaveLength(1)
			expect(types.filter(t => t === 'SQUAD_DISBANDED')).toHaveLength(1)
			expect(types.filter(t => t === 'PLAYER_DETAILS_CHANGED')).toHaveLength(1)

			expect(state.currTeams!.squads).toHaveLength(0)
			expect(state.currTeams!.players.find(p => p.ids.eos === 'eos-001')!.teamId).toBe(2)
		})
	})

	describe('event ordering', () => {
		it('yields rcon events in time order even when buffered out of order', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1)], [makeSquad(1, 1, 'eos-001', 100)])
			state.currTeams!.squads[0].uniqueId = 100

			// Buffer two SQUAD_RENAMED rcon events in reverse time order
			PendingEvents.onRconEvent(state, {
				type: 'SQUAD_RENAMED',
				time: 300,
				squadId: 1,
				teamId: 1,
				oldSquadName: 'Bravo',
				newSquadName: 'Charlie',
			})
			PendingEvents.onRconEvent(state, {
				type: 'SQUAD_RENAMED',
				time: 200,
				squadId: 1,
				teamId: 1,
				oldSquadName: 'Alpha',
				newSquadName: 'Bravo',
			})

			// Log event at t=301 unlocks both
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(301))
			const events = await collect(state)

			const renames = events.filter(e => e.type === 'SQUAD_RENAMED') as SE.SquadRenamed[]
			expect(renames).toHaveLength(2)
			expect(renames[0].time).toBe(200)
			expect(renames[1].time).toBe(300)
		})
	})

	describe('ordering invariants', () => {
		it('emitted event timestamps are non-decreasing within a process() call', async () => {
			// Two solo-leader squads; t=200 update: both leaders leave their squads
			// t=400 update: both squads formally gone (already disbanded, no new events)
			// All t=200 events must precede all t=400 events
			const p1 = makePlayer('eos-001', 1, { squadId: 1, isLeader: true })
			const p2 = makePlayer('eos-002', 1, { squadId: 2, isLeader: true })
			const sq1 = makeSquad(1, 1, 'eos-001', 101)
			const sq2 = makeSquad(2, 1, 'eos-002', 102)
			const state = makeSyncedState([p1, p2], [sq1, sq2])

			// t=200: both players leave their squads (2× PLAYER_LEFT_SQUAD, 2× SQUAD_DISBANDED)
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-001', 1), makePlayer('eos-002', 1)], []), 200)
			// t=400: nothing changes — no new events emitted, but time advances
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-001', 1), makePlayer('eos-002', 1)], []), 400)
			const events = await collect(state)

			expect(events.length).toBeGreaterThan(0)
			for (let i = 1; i < events.length; i++) {
				expect(events[i].time).toBeGreaterThanOrEqual(events[i - 1].time)
			}
		})

		it('emitted event IDs are strictly ascending within a process() call', async () => {
			const p1 = makePlayer('eos-001', 1, { squadId: 1, isLeader: true })
			const p2 = makePlayer('eos-002', 1, { squadId: 1 })
			const sq1 = makeSquad(1, 1, 'eos-001', 101)
			const state = makeSyncedState([p1, p2], [sq1])

			// p1 leaves squad1 as leader with p2 still in it → PLAYER_LEFT_SQUAD + PLAYER_PROMOTED_TO_LEADER
			PendingEvents.onTeamsPolled(
				state,
				makeTeams(
					[makePlayer('eos-001', 1), makePlayer('eos-002', 1, { squadId: 1, isLeader: true })],
					[sq1],
				),
				200,
			)
			const events = await collect(state)

			expect(events.length).toBeGreaterThan(1)
			for (let i = 1; i < events.length; i++) {
				expect(events[i].id).toBeGreaterThan(events[i - 1].id)
			}
		})

		it('emitted event IDs are strictly ascending across consecutive process() calls', async () => {
			const p1 = makePlayer('eos-001', 1, { squadId: 1, isLeader: true })
			const p2 = makePlayer('eos-002', 1, { squadId: 1 })
			const sq1 = makeSquad(1, 1, 'eos-001', 101)
			const state = makeSyncedState([p1, p2], [sq1])

			// Call 1: p1 leaves as leader → PLAYER_LEFT_SQUAD(p1) + PLAYER_PROMOTED_TO_LEADER(p2)
			PendingEvents.onTeamsPolled(
				state,
				makeTeams(
					[makePlayer('eos-001', 1), makePlayer('eos-002', 1, { squadId: 1 })],
					[sq1],
				),
				200,
			)
			const batch1 = await collect(state)

			// Call 2: p2 (now sole member) leaves → PLAYER_LEFT_SQUAD(p2) + SQUAD_DISBANDED
			PendingEvents.onTeamsPolled(
				state,
				makeTeams(
					[makePlayer('eos-001', 1), makePlayer('eos-002', 1)],
					[],
				),
				400,
			)
			const batch2 = await collect(state)

			const allEvents = [...batch1, ...batch2]
			expect(allEvents.length).toBeGreaterThan(2)
			for (let i = 1; i < allEvents.length; i++) {
				expect(allEvents[i].id).toBeGreaterThan(allEvents[i - 1].id)
			}
		})
	})
})
