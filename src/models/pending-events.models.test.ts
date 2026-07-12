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
	return collectAt(state, 0)
}

// collect while driving process() at a specific wall-clock `time` (for the sync watchdog, which is time-based)
async function collectAt(state: PendingEvents.State, time: number): Promise<SE.Event[]> {
	const events: SE.Event[] = []
	for await (const event of PendingEvents.process(state, time)) {
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
			ROUND_ENDED: { type: 'ROUND_ENDED', time, chainID: 0, raw: '' },
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
		it('first connection: yields RCON_CONNECTED, MAP_SET, roster-less NEW_GAME, then RESET with source=slm-started', async () => {
			const { state } = makeState()
			const events = await syncUp(state)
			expect(events).toHaveLength(4)
			expect(events[0]).toMatchObject({ type: 'RCON_CONNECTED' })
			expect(events[1]).toMatchObject({ type: 'MAP_SET' })
			// NEW_GAME is now a roster-less boundary marker; the roster arrives on the following RESET
			expect(events[2]).toMatchObject({ type: 'NEW_GAME', source: 'slm-started' })
			expect((events[2] as SE.NewGame).state).toBeUndefined()
			expect(events[3]).toMatchObject({ type: 'RESET', source: 'slm-started' })
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

		it('RESET carries the teams state from TEAMS_UPDATE (NEW_GAME is roster-less)', async () => {
			const { state } = makeState()
			const p1 = makePlayer('eos-001', 1)
			const events = await syncUp(state, { teams: makeTeams([p1]) })
			expect((events.find(e => e.type === 'NEW_GAME') as SE.NewGame).state).toBeUndefined()
			const reset = events.find(e => e.type === 'RESET') as SE.Reset
			expect(reset.state.players).toHaveLength(1)
			expect(reset.state.players[0]).toMatchObject({ ids: { eos: 'eos-001' } })
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

			// 2. Server transitions — TransitionMap NEW_GAME enters rolling, retaining the prior roster as a stale fallback
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
			expect(state.currTeams?.players).toHaveLength(2)

			// 3. Actual layer loads — non-TransitionMap NEW_GAME emits the roster-less boundary marker immediately
			PendingEvents.onLogEvent(state, {
				type: 'NEW_GAME',
				time: 400,
				chainID: 0,
				raw: '',
				mapClassname: 'Gorodok',
				layerClassname: LAYER_A_CLASSNAME,
			})
			const batch3 = await collect(state)
			expect(batch3).toHaveLength(1)
			expect(batch3[0]).toMatchObject({ type: 'NEW_GAME', source: 'server-roll' })
			expect((batch3[0] as SE.NewGame).state).toBeUndefined()
			expect(state.syncState).toMatchObject({ type: 'rolling', newGameEvent: expect.objectContaining({ type: 'NEW_GAME' }) })

			// 4. TEAMS_UPDATE arrives — carries the definitive roster as a RESET(server-roll)
			const newPlayers = [makePlayer('eos-new', 1)]
			PendingEvents.onTeamsPolled(state, makeTeams(newPlayers), 401)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(402))
			const batch4 = await collect(state)

			expect(batch4).toHaveLength(1)
			const reset = batch4[0] as SE.Reset
			expect(reset).toMatchObject({ type: 'RESET', source: 'server-roll' })
			expect(reset.state.players).toHaveLength(1)
			expect(reset.state.players[0]).toMatchObject({ ids: { eos: 'eos-new' } })
			expect(state.syncState.type).toBe('synced')
		})

		// End-to-end for B + C + A: a player still loading (team-less) during the roll is excluded from the
		// snapshot, but is recovered by reconcile as soon as a later poll shows them teamed.
		it('a player team-less during the roll is excluded from the snapshot then recovered once teamed', async () => {
			const { state } = makeState({ layerId: LAYER_A })
			await syncUp(state, { layerId: LAYER_A, teams: makeTeams([makePlayer('eos-001', 1)]) })
			state.nextLayerId = LAYER_A

			PendingEvents.onLogEvent(state, {
				type: 'NEW_GAME',
				time: 300,
				chainID: 0,
				raw: '',
				mapClassname: 'Transition',
				layerClassname: 'TransitionMap',
			})
			await collect(state)
			PendingEvents.onLogEvent(state, {
				type: 'NEW_GAME',
				time: 400,
				chainID: 0,
				raw: '',
				mapClassname: 'Gorodok',
				layerClassname: LAYER_A_CLASSNAME,
			})
			await collect(state)

			// first post-roll poll: eos-001 teamed, eos-straggler still loading (team-less)
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-001', 1), makePlayer('eos-straggler', 1, { teamId: null })]), 401)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(402))
			const rollBatch = await collect(state)
			const reset = rollBatch.find(e => e.type === 'RESET') as SE.Reset
			expect(reset).toMatchObject({ source: 'server-roll' })
			expect(reset.state.players.map(p => p.ids.eos)).toEqual(['eos-001']) // straggler excluded from snapshot
			expect(state.syncState.type).toBe('synced')
			expect(state.currTeams?.players.some(p => p.ids.eos === 'eos-straggler')).toBe(false)

			// next poll: straggler now teamed -> reconcile ADD recovers them (as PLAYER_RECONCILED, not a fresh connect)
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-001', 1), makePlayer('eos-straggler', 2)]), 500)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(501))
			const batch2 = await collect(state)
			expect(batch2.some(e => e.type === 'PLAYER_RECONCILED')).toBe(true)
			expect(batch2.some(e => e.type === 'PLAYER_CONNECTED')).toBe(false)
			expect(state.currTeams?.players.find(p => p.ids.eos === 'eos-straggler')?.teamId).toBe(2)
		})

		it('defers sync on a transitional poll where players exist but none are teamed', async () => {
			const { state } = makeState({ layerId: LAYER_A })
			PendingEvents.onRconConnected(state, 100, LAYER_A, LAYER_A)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(101))
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-001', 1, { teamId: null })]), 100)
			const batch = await collect(state)
			// the roster-less NEW_GAME boundary is emitted at connect, but the roster (RESET) is deferred
			expect(batch.some(e => e.type === 'NEW_GAME')).toBe(true)
			expect(batch.some(e => e.type === 'RESET')).toBe(false)
			expect(state.syncState.type).toBe('syncing')

			// once a player is teamed, sync completes with the RESET
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-001', 1)]), 200)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const batch2 = await collect(state)
			expect(batch2.some(e => e.type === 'RESET')).toBe(true)
			expect(state.syncState.type).toBe('synced')
		})
	})

	describe('rolling / server-roll flow', () => {
		it('TransitionMap NEW_GAME sets rolling and retains the prior roster as a stale fallback', async () => {
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
			// B: the roster is kept (stale) rather than nulled; the post-roll NEW_GAME snapshot replaces it.
			expect(state.currTeams?.players).toHaveLength(1)
		})

		it('non-TransitionMap NEW_GAME yields a roster-less NEW_GAME(server-roll) then a RESET carrying the roster', async () => {
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
			expect(newGame!.state).toBeUndefined()
			const reset = events.find(e => e.type === 'RESET') as SE.Reset | undefined
			expect(reset).toBeDefined()
			expect(reset!.source).toBe('server-roll')
			expect(reset!.state.players).toHaveLength(1)
		})
	})

	describe('sync watchdog', () => {
		it('force-resyncs from RCON when wedged in rolling past the timeout', async () => {
			const { state } = makeState({ layerId: LAYER_A })
			await syncUp(state, { layerId: LAYER_A })
			// RCON can report the current layer, so the resync can proceed; the new match is treated as new.
			state.hooks.fetchLayersStatus = vi.fn().mockResolvedValue({ currentLayer: { id: LAYER_A } })
			state.hooks.onNewGameDuringSync = vi.fn().mockResolvedValue({ match: makeMatchDetails(3, LAYER_A), isNewMatch: true })

			// enter rolling via a TransitionMap NEW_GAME whose real-layer NEW_GAME log never arrives
			PendingEvents.onLogEvent(state, {
				type: 'NEW_GAME',
				time: 1000,
				chainID: 0,
				raw: '',
				mapClassname: 'Transition',
				layerClassname: 'TransitionMap',
			})
			await collectAt(state, 1000)
			expect(state.syncState.type).toBe('rolling')

			// a tick while rolling arms the watchdog clock; still within the timeout -> no fire
			const armed = await collectAt(state, 2000)
			expect(armed.some(e => e.type === 'NEW_GAME')).toBe(false)
			expect(state.syncState.type).toBe('rolling')

			// past the timeout -> watchdog forces a resync back to syncing, emitting a NEW_GAME(new-game-detected)
			const fireTime = 2000 + PendingEvents.SYNC_WATCHDOG_TIMEOUT_MS + 1
			const fired = await collectAt(state, fireTime)
			expect(fired.some(e => e.type === 'NEW_GAME' && (e as SE.NewGame).source === 'new-game-detected')).toBe(true)
			expect(state.syncState.type).toBe('syncing')

			// the next teams poll after the resync boundary completes it
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-1', 1)]), fireTime + 100)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(fireTime + 101))
			await collectAt(state, fireTime + 200)
			expect(state.syncState.type).toBe('synced')
		})

		it('does not fire during a normal (prompt) roll', async () => {
			const { state } = makeState({ layerId: LAYER_A })
			await syncUp(state, { layerId: LAYER_A })
			state.nextLayerId = LAYER_A
			state.hooks.fetchLayersStatus = vi.fn().mockResolvedValue({ currentLayer: { id: LAYER_A } })

			PendingEvents.onLogEvent(state, {
				type: 'NEW_GAME',
				time: 1000,
				chainID: 0,
				raw: '',
				mapClassname: 'Transition',
				layerClassname: 'TransitionMap',
			})
			await collectAt(state, 1000)
			PendingEvents.onLogEvent(state, {
				type: 'NEW_GAME',
				time: 1100,
				chainID: 0,
				raw: '',
				mapClassname: 'Gorodok',
				layerClassname: LAYER_A_CLASSNAME,
			})
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-1', 1)]), 1200)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(1300))
			const events = await collectAt(state, 1400)

			expect(state.syncState.type).toBe('synced')
			expect(state.hooks.fetchLayersStatus).not.toHaveBeenCalled()
			expect(events.some(e => e.type === 'NEW_GAME' && (e as SE.NewGame).source === 'new-game-detected')).toBe(false)
		})

		it('a failed layer resolution during a roll leaves plain rolling (no newGameEvent), never completing against the stale match', async () => {
			const { state } = makeState({ layerId: LAYER_A, matchId: 1 })
			await syncUp(state, { layerId: LAYER_A }) // synced on match 1
			state.hooks.fetchLayersStatus = vi.fn().mockResolvedValue(null) // resolution will fail during the roll

			PendingEvents.onLogEvent(state, {
				type: 'NEW_GAME',
				time: 1000,
				chainID: 0,
				raw: '',
				mapClassname: 'Transition',
				layerClassname: 'TransitionMap',
			})
			await collectAt(state, 1000)
			// real-layer NEW_GAME whose classname mismatches the expected layer -> must fetchLayersStatus (which fails)
			PendingEvents.onLogEvent(state, {
				type: 'NEW_GAME',
				time: 1100,
				chainID: 0,
				raw: '',
				mapClassname: 'Kohat',
				layerClassname: 'Kohat_RAAS_v1',
			})
			const rollBatch = await collectAt(state, 1100)

			expect(state.hooks.fetchLayersStatus).toHaveBeenCalled()
			expect(rollBatch.some(e => e.type === 'NEW_GAME')).toBe(false)
			// plain rolling, crucially WITHOUT a newGameEvent
			expect(state.syncState).toEqual({ type: 'rolling' })

			// a subsequent poll must NOT complete the roll (no RESET against the stale match)
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-1', 1)]), 1200)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(1300))
			const pollBatch = await collectAt(state, 1400)
			expect(pollBatch.some(e => e.type === 'RESET')).toBe(false)
			expect(state.syncState.type).toBe('rolling')
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

		it('emits PLAYER_CONNECTED for a teamed player we never saw before (genuine arrival / missed connect log)', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1)], [])

			// eos-002 is on the server per RCON but was never added to currTeams and was never seen team-less (e.g.
			// their connect log dropped during a roll and they were already teamed by the time RCON listed them).
			const polled = makeTeams([makePlayer('eos-001', 1), makePlayer('eos-002', 2)])
			PendingEvents.onTeamsPolled(state, polled, 200)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const events = await collect(state)

			const connects = events.filter(e => e.type === 'PLAYER_CONNECTED') as SE.PlayerConnected[]
			expect(connects).toHaveLength(1)
			expect(connects[0].player.ids.eos).toBe('eos-002')
			expect(connects[0].player.teamId).toBe(2)
			expect(events.some(e => e.type === 'PLAYER_RECONCILED')).toBe(false)
			expect(state.currTeams?.players.some(p => p.ids.eos === 'eos-002')).toBe(true)
		})

		it('emits PLAYER_RECONCILED (not PLAYER_CONNECTED) for a player we saw team-less who then gets a team', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1)], [])

			// poll 1: eos-002 present but still loading (team-less) -> tracked, not added, no event
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-001', 1), makePlayer('eos-002', 1, { teamId: null })]), 200)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const batch1 = await collect(state)
			expect(batch1.some(e => e.type === 'PLAYER_CONNECTED' || e.type === 'PLAYER_RECONCILED')).toBe(false)
			expect(state.currTeams?.players.some(p => p.ids.eos === 'eos-002')).toBe(false)

			// poll 2: eos-002 now teamed -> backfill of a player we were tracking -> PLAYER_RECONCILED
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-001', 1), makePlayer('eos-002', 2)]), 300)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(301))
			const batch2 = await collect(state)
			expect(batch2.some(e => e.type === 'PLAYER_RECONCILED')).toBe(true)
			expect(batch2.some(e => e.type === 'PLAYER_CONNECTED')).toBe(false)
			expect(state.currTeams?.players.find(p => p.ids.eos === 'eos-002')?.teamId).toBe(2)
		})

		it('does not emit a spurious add for players already in currTeams', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1)], [])

			const polled = makeTeams([makePlayer('eos-001', 1)])
			PendingEvents.onTeamsPolled(state, polled, 200)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const events = await collect(state)

			expect(events.some(e => e.type === 'PLAYER_RECONCILED' || e.type === 'PLAYER_CONNECTED')).toBe(false)
		})

		it('establishes squad membership for an added player via PLAYER_JOINED_SQUAD', async () => {
			const squad = makeSquad(1, 1, 'eos-001', 100)
			const state = makeSyncedState([makePlayer('eos-001', 1, { squadId: 1 })], [squad])

			// eos-002 is added (never seen before -> PLAYER_CONNECTED) and is in squad 1 per the poll
			const polled = makeTeams([makePlayer('eos-001', 1, { squadId: 1 }), makePlayer('eos-002', 1, { squadId: 1 })], [squad])
			PendingEvents.onTeamsPolled(state, polled, 200)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const events = await collect(state)

			const types = events.map(e => e.type)
			expect(types).toContain('PLAYER_CONNECTED')
			expect(types).toContain('PLAYER_JOINED_SQUAD')
			const recovered = state.currTeams?.players.find(p => p.ids.eos === 'eos-002')
			expect(recovered?.squadId).toBe(1)
		})

		// Poll a team where eos-002 is absent, advancing the clock each time.
		async function pollAbsent(state: PendingEvents.State, time: number): Promise<SE.Event[]> {
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-001', 1)]), time)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(time + 1))
			return collect(state)
		}

		it('culls a player absent from the poll once the debounce threshold is reached', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1), makePlayer('eos-002', 1)], [])

			// first miss: grace poll, no cull
			const batch1 = await pollAbsent(state, 200)
			expect(batch1.some(e => e.type === 'PLAYER_DISCONNECTED')).toBe(false)
			expect(state.currTeams?.players.some(p => p.ids.eos === 'eos-002')).toBe(true)

			// second consecutive miss: cull
			const batch2 = await pollAbsent(state, 300)
			const dc = batch2.find(e => e.type === 'PLAYER_DISCONNECTED') as SE.PlayerDisconnected
			expect(dc).toBeDefined()
			expect(dc.player).toBe('eos-002')
			expect(state.currTeams?.players.some(p => p.ids.eos === 'eos-002')).toBe(false)
		})

		it('does not cull a player after a single missed poll', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1), makePlayer('eos-002', 1)], [])
			const batch = await pollAbsent(state, 200)
			expect(batch.some(e => e.type === 'PLAYER_DISCONNECTED')).toBe(false)
			expect(state.currTeams?.players).toHaveLength(2)
		})

		it('resets the absence streak when a player reappears, so misses must be consecutive to cull', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1), makePlayer('eos-002', 1)], [])

			await pollAbsent(state, 200) // miss 1
			// eos-002 present again -> streak reset
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-001', 1), makePlayer('eos-002', 1)]), 300)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(301))
			await collect(state)

			const batch = await pollAbsent(state, 400) // miss 1 again, not 2 consecutive
			expect(batch.some(e => e.type === 'PLAYER_DISCONNECTED')).toBe(false)
			expect(state.currTeams?.players.some(p => p.ids.eos === 'eos-002')).toBe(true)
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

	describe('unknown-squad SQUAD_CREATED synthesis', () => {
		// Poll a roster where eos-001 is in squad 1, whose creator ('eos-ghost') already left the server, advancing the clock.
		function pollWithUnknownSquad(state: PendingEvents.State, time: number, extraPlayers: SM.Player[] = []): Promise<SE.Event[]> {
			const squad: SM.Squad = { squadId: 1, teamId: 1, creator: 'eos-ghost', squadName: 'Alpha', locked: false }
			PendingEvents.onTeamsPolled(
				state,
				makeTeams([makePlayer('eos-001', 1, { squadId: 1, isLeader: true }), ...extraPlayers], [squad]),
				time,
			)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(time + 1))
			return collect(state)
		}

		it('synthesizes SQUAD_CREATED once the unknown-squad poll streak reaches the threshold', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1)], [])

			// polls 1-2: cycle held awaiting the creation log; no squad events yet
			const batch1 = await pollWithUnknownSquad(state, 200)
			expect(batch1.some(e => e.type === 'SQUAD_CREATED')).toBe(false)
			// presence recovery still runs during held cycles
			const batch2 = await pollWithUnknownSquad(state, 300, [makePlayer('eos-002', 2)])
			expect(batch2.some(e => e.type === 'SQUAD_CREATED')).toBe(false)
			expect(batch2.some(e => e.type === 'PLAYER_CONNECTED')).toBe(true)

			// poll 3: threshold reached -> synthesized SQUAD_CREATED, with membership established from the same poll
			const batch3 = await pollWithUnknownSquad(state, 400, [makePlayer('eos-002', 2)])
			const created = batch3.find(e => e.type === 'SQUAD_CREATED') as SE.SquadCreated
			expect(created).toMatchObject({
				synthesized: true,
				squad: expect.objectContaining({ squadId: 1, teamId: 1, creator: 'eos-ghost', squadName: 'Alpha' }),
			})
			expect(batch3.find(e => e.type === 'PLAYER_JOINED_SQUAD')).toMatchObject({
				player: 'eos-001',
				uniqueId: created.squad.uniqueId,
			})
			expect(batch3.some(e => e.type === 'PLAYER_PROMOTED_TO_LEADER')).toBe(true)

			// the squad is tracked in currTeams despite the unresolvable creator
			expect(state.currTeams?.squads.find(s => s.uniqueId === created.squad.uniqueId)).toBeDefined()
			expect(state.currTeams?.players.find(p => p.ids.eos === 'eos-001')?.squadId).toBe(1)

			// poll 4: the squad now matches normally; no re-synthesis
			const batch4 = await pollWithUnknownSquad(state, 500, [makePlayer('eos-002', 2)])
			expect(batch4.some(e => e.type === 'SQUAD_CREATED')).toBe(false)
		})

		it('resets the streak when the unknown squad disappears from a poll', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1)], [])

			await pollWithUnknownSquad(state, 200)
			await pollWithUnknownSquad(state, 300)

			// squad vanishes -> streak entry pruned
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-001', 1)]), 400)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(401))
			await collect(state)

			// reappears: a fresh threshold's worth of polls is required again
			const batch = await pollWithUnknownSquad(state, 500)
			expect(batch.some(e => e.type === 'SQUAD_CREATED')).toBe(false)
		})
	})

	describe('reconnect roster reseed', () => {
		const rosterTeams = () =>
			makeTeams(
				[makePlayer('eos-001', 1, { squadId: 1, isLeader: true })],
				[{ squadId: 1, teamId: 1, creator: 'eos-001', squadName: 'Alpha', locked: false }],
			)

		it('preserves squad uniqueIds when the reconnect resolves to the same match', async () => {
			const { state } = makeState({ isNewMatch: false })
			const events1 = await syncUp(state, { teams: rosterTeams() })
			const reset1 = events1.find(e => e.type === 'RESET') as SE.Reset
			const originalUniqueId = reset1.state.squads[0].uniqueId

			PendingEvents.onRconDisconnected(state, 300)
			await collect(state)

			PendingEvents.onRconConnected(state, 400, LAYER_A, LAYER_A)
			PendingEvents.onTeamsPolled(state, rosterTeams(), 410)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(411))
			const events2 = await collect(state)
			const reset2 = events2.find(e => e.type === 'RESET') as SE.Reset
			expect(reset2.state.squads[0].uniqueId).toBe(originalUniqueId)
		})

		it('mints fresh uniqueIds when the reconnect resolves to a different match', async () => {
			const { state, hooks } = makeState({ isNewMatch: false })
			const events1 = await syncUp(state, { teams: rosterTeams() })
			const reset1 = events1.find(e => e.type === 'RESET') as SE.Reset
			const originalUniqueId = reset1.state.squads[0].uniqueId

			PendingEvents.onRconDisconnected(state, 300)
			await collect(state)
			;(hooks.onNewGameDuringSync as ReturnType<typeof vi.fn>).mockResolvedValue({
				match: makeMatchDetails(99, LAYER_A),
				isNewMatch: true,
			})
			PendingEvents.onRconConnected(state, 400, LAYER_A, LAYER_A)
			PendingEvents.onTeamsPolled(state, rosterTeams(), 410)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(411))
			const events2 = await collect(state)
			const reset2 = events2.find(e => e.type === 'RESET') as SE.Reset
			expect(reset2.state.squads[0].uniqueId).not.toBe(originalUniqueId)
		})
	})

	describe('died/wounded victim resolution', () => {
		it('resolves a victim whose log name diverges from the RCON name via loose username match', async () => {
			const victim = makePlayer('eos-vic', 1)
			victim.ids.username = '『LiQ』  HoneyBooBoo rides again'
			const attacker = makePlayer('eos-atk', 2)
			const state = makeSyncedState([victim, attacker], [])

			PendingEvents.onLogEvent(state, {
				type: 'PLAYER_DIED',
				time: 1100,
				chainID: 1,
				raw: '',
				damage: 300,
				weapon: 'BP_Soldier',
				victimIds: { username: 'HoneyBooBoo rides again' },
				attackerIds: { eos: 'eos-atk', playerController: 'ctrl_eos-atk' },
			})
			const events = await collect(state)
			const died = events.find(e => e.type === 'PLAYER_DIED') as SE.PlayerDied
			expect(died).toBeDefined()
			expect(died.victim).toBe('eos-vic')
			expect(died.attacker).toBe('eos-atk')
		})
	})

	describe('application-event attribution (warn expectations)', () => {
		function warnEvent(reason: string, username: string, time: number): SM.RconEvents.Event {
			return { type: 'PLAYER_WARNED', time, reason, playerIds: { username } }
		}

		it('stamps a matching PLAYER_WARNED with the armed source and consumes the expectation', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1)], [])
			PendingEvents.expectWarn(state, { playerId: 'eos-001', reason: 'stop', source: { type: 'event', id: 'app-1' } })
			PendingEvents.onRconEvent(state, warnEvent('stop', 'eos-001', 200))
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const events = await collect(state)

			const warn = events.find(e => e.type === 'PLAYER_WARNED') as SE.PlayerWarned
			expect(warn).toBeDefined()
			expect(warn.source).toEqual({ type: 'event', id: 'app-1' })
			expect(state.expectations).toHaveLength(0)
		})

		it('does not attribute when the reason does not match, and leaves the expectation armed', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1)], [])
			PendingEvents.expectWarn(state, { playerId: 'eos-001', reason: 'stop teamkilling', source: { type: 'event', id: 'app-1' } })
			PendingEvents.onRconEvent(state, warnEvent('a different message', 'eos-001', 200))
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const events = await collect(state)

			const warn = events.find(e => e.type === 'PLAYER_WARNED') as SE.PlayerWarned
			expect(warn.source).toBeUndefined()
			expect(state.expectations).toHaveLength(1)
		})

		it('does not attribute a warn for a different player', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1), makePlayer('eos-002', 1)], [])
			PendingEvents.expectWarn(state, { playerId: 'eos-002', reason: 'stop', source: { type: 'event', id: 'app-1' } })
			PendingEvents.onRconEvent(state, warnEvent('stop', 'eos-001', 200))
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const events = await collect(state)

			const warn = events.find(e => e.type === 'PLAYER_WARNED') as SE.PlayerWarned
			expect(warn.source).toBeUndefined()
		})

		it('attributes each of a repeated warn via one consume-once expectation apiece (warnAll aggregation)', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1)], [])
			const source = { type: 'event' as const, id: 'app-1' }
			PendingEvents.expectWarn(state, { playerId: 'eos-001', reason: 'stop', source })
			PendingEvents.expectWarn(state, { playerId: 'eos-001', reason: 'stop', source })
			PendingEvents.onRconEvent(state, warnEvent('stop', 'eos-001', 200))
			PendingEvents.onRconEvent(state, warnEvent('stop', 'eos-001', 201))
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(202))
			const events = await collect(state)

			const warns = events.filter(e => e.type === 'PLAYER_WARNED') as SE.PlayerWarned[]
			expect(warns).toHaveLength(2)
			expect(warns.every(w => w.source?.type === 'event' && w.source.id === 'app-1')).toBe(true)
			expect(state.expectations).toHaveLength(0)
		})

		it('prunes an expired expectation without attributing', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1)], [])
			PendingEvents.pushExpectation(state, {
				match: { type: 'PLAYER_WARNED', playerId: 'eos-001', reason: 'stop' },
				source: { type: 'event', id: 'app-1' },
				expiresAt: -1,
			})
			PendingEvents.onRconEvent(state, warnEvent('stop', 'eos-001', 200))
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const events = await collect(state)

			const warn = events.find(e => e.type === 'PLAYER_WARNED') as SE.PlayerWarned
			expect(warn.source).toBeUndefined()
			expect(state.expectations).toHaveLength(0)
		})

		it('attributes an admin-caused PLAYER_CHANGED_TEAM to an armed team-change expectation (switchPlayers)', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1)], [])
			PendingEvents.armExpectation(state, { type: 'PLAYER_CHANGED_TEAM', playerId: 'eos-001' }, { type: 'event', id: 'app-1' })
			// the admin-command log marks the switch, so the poll's PLAYER_CHANGED_TEAM is admin-caused (has a source)
			PendingEvents.onLogEvent(state, {
				type: 'ADMIN_FORCED_TEAM_CHANGE',
				time: 2000,
				chainID: 0,
				raw: '',
				playerIds: { eos: 'eos-001', username: 'eos-001' },
				source: { type: 'rcon' },
			})
			await collect(state)
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-001', 2)], []), 3000)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(3000))
			const events = await collect(state)

			const changed = events.find(e => e.type === 'PLAYER_CHANGED_TEAM') as SE.PlayerChangedTeam
			expect(changed?.source).toEqual({ type: 'event', id: 'app-1' })
			expect(state.expectations).toHaveLength(0)
		})

		it('does NOT attribute an organic (poll-inferred) PLAYER_CHANGED_TEAM, leaving the expectation armed', async () => {
			const state = makeSyncedState([makePlayer('eos-001', 1)], [])
			PendingEvents.armExpectation(state, { type: 'PLAYER_CHANGED_TEAM', playerId: 'eos-001' }, { type: 'event', id: 'app-1' })
			// no admin-command log -> the poll event has no native source -> it's organic, not SLM's switch
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-001', 2)], []), 500)
			const events = await collect(state)

			const changed = events.find(e => e.type === 'PLAYER_CHANGED_TEAM') as SE.PlayerChangedTeam
			expect(changed?.source).toBeUndefined()
			expect(state.expectations).toHaveLength(1)
		})

		it('attributes an admin-caused PLAYER_LEFT_SQUAD to an armed remove expectation (removeFromSquad)', async () => {
			const removed = makePlayer('eos-removed', 1, { squadId: 1 })
			const leader = makePlayer('eos-leader', 1, { squadId: 1, isLeader: true })
			const state = makeSyncedState([removed, leader], [makeSquad(1, 1, 'eos-leader', 101)])
			PendingEvents.armExpectation(state, { type: 'PLAYER_LEFT_SQUAD', playerId: 'eos-removed' }, { type: 'event', id: 'app-1' })
			PendingEvents.onLogEvent(state, {
				type: 'ADMIN_REMOVED_FROM_SQUAD',
				time: 2000,
				chainID: 0,
				raw: '',
				playerIds: { username: 'eos-removed' },
				source: { type: 'rcon' },
			})
			const events = await collect(state)

			const left = events.find(e => e.type === 'PLAYER_LEFT_SQUAD') as SE.PlayerLeftSquad
			expect(left?.source).toEqual({ type: 'event', id: 'app-1' })
			expect(state.expectations).toHaveLength(0)
		})

		it('attributes an admin-caused SQUAD_DISBANDED to an armed disband expectation, resolving uniqueId->teamId/squadId', async () => {
			const player = makePlayer('eos-1', 1, { squadId: 1, isLeader: true })
			const state = makeSyncedState([player], [makeSquad(1, 1, 'eos-1', 101)])
			PendingEvents.armExpectation(state, { type: 'SQUAD_DISBANDED', teamId: 1, squadId: 1 }, { type: 'event', id: 'app-1' })
			PendingEvents.onLogEvent(state, {
				type: 'ADMIN_DISBANDED_SQUAD',
				time: 2000,
				chainID: 0,
				raw: '',
				squadId: 1,
				teamId: 1,
				squadName: 'Squad 1',
				source: { type: 'rcon' },
			})
			const events = await collect(state)

			const disbanded = events.find(e => e.type === 'SQUAD_DISBANDED') as SE.SquadDisbanded
			expect(disbanded?.source).toEqual({ type: 'event', id: 'app-1' })
			expect(state.expectations).toHaveLength(0)
		})

		it('attributes a SQUAD_RENAMED to an armed rename expectation', async () => {
			const p1 = makePlayer('eos-001', 1, { squadId: 1 })
			const squad = makeSquad(1, 1, 'eos-001', 100)
			const state = makeSyncedState([p1], [squad])
			PendingEvents.armExpectation(state, { type: 'SQUAD_RENAMED', teamId: 1, squadId: 1 }, { type: 'event', id: 'app-1' })
			PendingEvents.onRconEvent(state, {
				type: 'SQUAD_RENAMED',
				time: 200,
				squadId: 1,
				teamId: 1,
				oldSquadName: 'Alpha',
				newSquadName: 'Squad 1',
			})
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(201))
			const events = await collect(state)

			const renamed = events.find(e => e.type === 'SQUAD_RENAMED') as SE.SquadRenamed
			expect(renamed?.source).toEqual({ type: 'event', id: 'app-1' })
			expect(state.expectations).toHaveLength(0)
		})
	})

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

	describe('admin command log events (attribution + poll idempotency)', () => {
		it('forced team change: the log records an attribution but emits nothing; the next poll carries it', async () => {
			const state = makeSyncedState([makePlayer('eos-1', 1)], [])

			PendingEvents.onLogEvent(state, {
				type: 'ADMIN_FORCED_TEAM_CHANGE',
				time: 2000,
				chainID: 0,
				raw: '',
				playerIds: { eos: 'eos-1', username: 'eos-1' },
				source: { type: 'rcon' },
			})
			const fromLog = await collect(state)
			// the log itself emits nothing -- the poll is the source of truth for the team change
			expect(fromLog.find(e => e.type === 'PLAYER_CHANGED_TEAM')).toBeUndefined()

			// the poll reflects team 2 and picks up the recorded attribution
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-1', 2)], []), 3000)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(3000))
			const fromPoll = await collect(state)
			expect(fromPoll.find(e => e.type === 'PLAYER_CHANGED_TEAM')).toMatchObject({
				player: 'eos-1',
				newTeamId: 2,
				source: { type: 'rcon' },
			})
			// the marker was consumed
			expect(state.forcedTeamChanges.size).toBe(0)
		})

		it('forced team change: attribution is wiped on the next poll even when unused (no stale attribution later)', async () => {
			const state = makeSyncedState([makePlayer('eos-1', 1)], [])

			PendingEvents.onLogEvent(state, {
				type: 'ADMIN_FORCED_TEAM_CHANGE',
				time: 2000,
				chainID: 0,
				raw: '',
				playerIds: { eos: 'eos-1', username: 'eos-1' },
				source: { type: 'rcon' },
			})
			await collect(state)

			// a poll with no team change for that player discards the unused marker
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-1', 1)], []), 3000)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(3000))
			await collect(state)
			expect(state.forcedTeamChanges.size).toBe(0)

			// a later organic switch must NOT carry the stale attribution
			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-1', 2)], []), 4000)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(4000))
			const events = await collect(state)
			const changed = events.find(e => e.type === 'PLAYER_CHANGED_TEAM')
			expect(changed).toMatchObject({ player: 'eos-1', newTeamId: 2 })
			expect((changed as SE.PlayerChangedTeam).source).toBeUndefined()
		})

		it('disband: emits attributed PLAYER_LEFT_SQUAD + SQUAD_DISBANDED; a following poll does not re-fire', async () => {
			const player = makePlayer('eos-1', 1, { squadId: 1, isLeader: true })
			const state = makeSyncedState([player], [makeSquad(1, 1, 'eos-1', 101)])

			PendingEvents.onLogEvent(state, {
				type: 'ADMIN_DISBANDED_SQUAD',
				time: 2000,
				chainID: 0,
				raw: '',
				squadId: 1,
				teamId: 1,
				squadName: 'Squad 1',
				source: { type: 'rcon' },
			})
			const events = await collect(state)

			expect(events.find(e => e.type === 'PLAYER_LEFT_SQUAD')).toMatchObject({
				player: 'eos-1',
				uniqueId: 101,
				source: { type: 'rcon' },
			})
			expect(events.find(e => e.type === 'SQUAD_DISBANDED')).toMatchObject({
				uniqueId: 101,
				source: { type: 'rcon' },
			})
			expect(state.currTeams!.squads).toHaveLength(0)

			PendingEvents.onTeamsPolled(state, makeTeams([makePlayer('eos-1', 1)], []), 3000)
			PendingEvents.onLogEvent(state, makeUnknownLogEvent(3000))
			const after = await collect(state)
			expect(after.find(e => e.type === 'SQUAD_DISBANDED')).toBeUndefined()
		})

		it('remove from squad: resolves the target by username and emits an attributed PLAYER_LEFT_SQUAD', async () => {
			const removed = makePlayer('eos-removed', 1, { squadId: 1 })
			const leader = makePlayer('eos-leader', 1, { squadId: 1, isLeader: true })
			const state = makeSyncedState([removed, leader], [makeSquad(1, 1, 'eos-leader', 101)])

			PendingEvents.onLogEvent(state, {
				type: 'ADMIN_REMOVED_FROM_SQUAD',
				time: 2000,
				chainID: 0,
				raw: '',
				playerIds: { username: 'eos-removed' },
				source: { type: 'rcon' },
			})
			const events = await collect(state)

			expect(events.find(e => e.type === 'PLAYER_LEFT_SQUAD')).toMatchObject({
				player: 'eos-removed',
				uniqueId: 101,
				source: { type: 'rcon' },
			})
			expect(state.currTeams!.players.find(p => p.ids.eos === 'eos-removed')).toMatchObject({ squadId: null })
		})

		it('remove from squad: unknown username is skipped so the teams poll can reconcile organically', async () => {
			const state = makeSyncedState([makePlayer('eos-1', 1, { squadId: 1 })], [makeSquad(1, 1, 'eos-1', 101)])

			PendingEvents.onLogEvent(state, {
				type: 'ADMIN_REMOVED_FROM_SQUAD',
				time: 2000,
				chainID: 0,
				raw: '',
				playerIds: { username: 'nobody' },
				source: { type: 'rcon' },
			})
			const events = await collect(state)
			expect(events.find(e => e.type === 'PLAYER_LEFT_SQUAD')).toBeUndefined()
		})
	})
})
