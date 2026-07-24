import * as Arr from '@/lib/array'
import * as Gen from '@/lib/generator'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import type * as Types from '@/lib/types'
import * as CS from '@/models/context-shared'
import * as L from '@/models/layer'
import type * as MH from '@/models/match-history.models'
import type { ActionSource } from '@/models/server-events-base.models'
import * as SE from '@/models/server-events.models'
import * as SM from '@/models/squad.models'
import { z } from 'zod'
// `time` is when the poll's response was received; it drives ordering, staleness and the log-lead guard exactly
// as any other event. `polledAt` is when the underlying ListPlayers request was issued (see TeamsRes.polledAt) --
// a lower bound on when the snapshot was taken. Only the roll-completion gate keys off `polledAt`: a response in
// flight across the (near-instant) roll still carries the pre-roll roster yet is received after the roll's
// NEW_GAME, so gating on receive time would let that stale snapshot complete the roll. Everything else, including
// ordering, stays on `time` -- a poll whose snapshot reflects a just-landed connect must sort after that connect's
// log, and the sync boundary (unlike a roll) is never straddled by an in-flight poll (see the syncing branch).
type TeamsUpdateEvent = { type: 'TEAMS_UPDATE'; id: number; teams: SM.Teams; time: number; polledAt: number }
export type Attribution = {
	type: 'MAP_SET_ATTRIBUTION'
	itemId: string
	layerId: L.LayerId
	time: number
	// when set, the resulting MAP_SET links to this app event instead of the bespoke layer-queue source. it's whichever
	// app event renders in the feed (a QUEUE_UPDATED, or a MAP_SET for an override), so the server event collapses into it
	appEventId?: string
}

// how long an armed expectation lives before it's GC'd if its event never lands (RCON error, player left).
// matched expectations are consumed immediately, so this is only a safety net -- NOT the matching window.
export const DEFAULT_EXPECTATION_TTL_MS = 60_000

// how long a pending MAP_SET attribution lives before it's GC'd if its MAP_SET never lands. Same safety-net role
// as the expectation TTL: matching ones are consumed on match, so this only drops sets the server never reported.
export const ATTRIBUTION_TTL_MS = 60_000

// number of consecutive teams polls a player in currTeams must be absent from RCON ListPlayers before we cull
// them. 2 == one grace poll, so a single dropped/partial poll never evicts a still-connected player. At the ~5s
// teams TTL this is a ~10s window; a real disconnect is normally removed far sooner by its log line, so culling
// only fires for disconnects whose log line was missed.
export const POLL_ABSENCE_CULL_THRESHOLD = 2

// consecutive teams polls an unknown squad is tolerated before we give up waiting on its SQUAD_CREATED log and
// synthesize the event from poll data. Must comfortably exceed ordinary log-vs-poll lag (the driver already holds
// back TEAMS_UPDATE processing by minSafeLeadTimeForOtherEventsSinceLog, so this is extra margin on a heuristic).
export const UNKNOWN_SQUAD_SYNTHESIS_THRESHOLD = 3

// how long we tolerate being stuck mid-sync ('syncing'/'rolling') before the watchdog force-resyncs from RCON. A
// normal roll/sync completes within seconds (first teamed poll after the boundary), so this only fires when the
// state machine is genuinely wedged -- e.g. a roll whose real-layer NEW_GAME log never arrived.
export const SYNC_WATCHDOG_TIMEOUT_MS = 90_000

// SLM arms an expectation (before issuing an action's RCON command) so that when a matching server event is later
// produced, process() stamps its `source` -- linking it to the SLM app event that caused it -- and consumes
// the expectation. See squad-rcon.server.ts warn/warnAll.
export type ArmedActionSource = Extract<ActionSource, { type: 'event' } | { type: 'system' }>
// how to recognize the server event an armed action should be attributed to. player-keyed for actions whose server
// events carry a `player`; squad-keyed (by in-game teamId/squadId, resolved via currTeams) for disbands.
export type ExpectationMatch =
	| { type: 'PLAYER_WARNED'; playerId: SM.PlayerId; reason?: string }
	| { type: 'PLAYER_KICKED'; playerId: SM.PlayerId }
	| { type: 'PLAYER_LEFT_SQUAD'; playerId: SM.PlayerId }
	| { type: 'PLAYER_CHANGED_TEAM'; playerId: SM.PlayerId }
	| { type: 'SQUAD_DISBANDED'; teamId: SM.TeamId; squadId: number }
	| { type: 'SQUAD_RENAMED'; teamId: SM.TeamId; squadId: number }
export type EventExpectation = {
	match: ExpectationMatch
	source: ArmedActionSource
	expiresAt: number
}
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

	// players an admin forced to change teams (keyed by player id) -> the admin action source ("why").
	// consumed by the next teams poll's PLAYER_CHANGED_TEAM, then wiped -- a marker is valid for exactly one poll.
	forcedTeamChanges: Map<SM.PlayerId, SM.LogEvents.ActionSource>

	// SLM-armed expectations: match an upcoming server event and stamp its `source` (see EventExpectation)
	expectations: EventExpectation[]

	nextLayerId: L.LayerId | null
	expectedNewLayerId: L.LayerId | null

	currentMatch: {
		historyEntryId: number
		layerId: L.LayerId
	} | 'PENDING'

	// Sync/roll lifecycle. In both 'syncing' and 'rolling' we've established the match boundary (and emitted a
	// roster-less NEW_GAME for new matches) and are awaiting the first teams poll timestamped after `boundaryTime`;
	// that poll produces the RESET carrying the definitive roster and flips us to 'synced'. Polls at or before
	// `boundaryTime` are stale (previous match / pre-boundary) and discarded. 'rolling' additionally waits for the
	// real-layer NEW_GAME log (`newGameEvent`) after the TransitionMap before its boundary is known.
	syncState:
		| { type: 'desynced' }
		| { type: 'syncing'; isNewMatch: boolean; boundaryTime: number }
		| { type: 'rolling'; newGameEvent?: SM.LogEvents.NewGame & { id: number } }
		| { type: 'synced' }

	// wall-clock time we entered a mid-sync state ('syncing'/'rolling'), for the roll watchdog. While non-synced
	// every event is dropped, so a roll whose real-layer NEW_GAME log never arrives would wedge us indefinitely;
	// the watchdog force-resyncs from RCON once this exceeds SYNC_WATCHDOG_TIMEOUT_MS. Null while synced/desynced.
	nonSyncedSince: number | null

	isFirstConnection: boolean | null
	admins: Set<string>
	currTeams: SM.UniqueTeams | null
	// consecutive teams polls in which a player currently in currTeams was absent from RCON ListPlayers. Used to
	// debounce poll-driven culling (see reconcileTeamsUpdate) so a single dropped/partial poll doesn't evict a
	// still-connected player. Only ever holds currently-absent, not-yet-culled players; entries self-prune.
	pollAbsenceStreaks: Map<SM.PlayerId, number>

	// consecutive teams polls in which a polled squad had no match in currTeams (keyed by team-squadId:creator).
	// Once a streak reaches UNKNOWN_SQUAD_SYNTHESIS_THRESHOLD we assume the SQUAD_CREATED log was missed and
	// synthesize the event from poll data instead of blocking team updates until the next RESET. Self-pruning.
	unknownSquadStreaks: Map<string, number>

	// the roster at the moment of the last RCON disconnect. When the reconnect resolves to the SAME match, the
	// reseeding RESET reuses these squads' uniqueIds (an RCON blip shouldn't make every squad look recreated) and
	// backfills name-derived player ids (usernameNoTag) that polls can't provide. Consumed on the next sync.
	staleTeamsFromDisconnect: { matchId: number; teams: SM.UniqueTeams } | null

	// players RCON currently reports without a team (still loading / unassigned). currTeams stays teamed-only, so
	// these aren't in it yet. When one later appears teamed we recognize it as a backfill of a player we were
	// already aware of (PLAYER_RECONCILED) rather than a fresh arrival (PLAYER_CONNECTED). Rebuilt every poll.
	unassignedPlayers: Set<SM.PlayerId>
	counters: {
		squadId: Generator<number, never, unknown>
		pendingEventId: Generator<number, never, unknown>
	}
	log: CS.Logger
	hooks: {
		onNewGameDuringRoll: (newLayerId: L.LayerId, time: number) => Promise<{ match: MH.MatchDetails; nextLayerId: L.LayerId | null }>
		onNewGameDuringSync: (newLayerId: L.LayerId, time: number) => Promise<{ match: MH.MatchDetails; isNewMatch: boolean }>
		fetchLayersStatus: () => Promise<SM.LayersStatus | null>
		// Persists the event and returns it with the id the insert allocated. Every event this module emits goes
		// through here first, so an event is on disk before any consumer (or our own state) ever sees it, and ids
		// are handed out in emission order.
		createEvent: (event: SE.NewEvent) => Promise<SE.Event>
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
		'PLAYER_RECONCILED',
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
		pollAbsenceStreaks: new Map(),
		unknownSquadStreaks: new Map(),
		staleTeamsFromDisconnect: null,
		unassignedPlayers: new Set(),
		nonSyncedSince: null,
		expectedNewLayerId: null,
		eventBufs: {
			rconEmittedEvents: [],
			logEvents: [],
			lifecycleEvents: [],
			teamsUpdates: [],
		},
		attributions: [],
		forcedTeamChanges: new Map(),
		expectations: [],
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

export function pushAttribution(state: State, attribution: Omit<Attribution, 'time'>) {
	state.attributions.push({ ...attribution, time: Date.now() })
}

export function pushExpectation(state: State, expectation: EventExpectation) {
	state.expectations.push(expectation)
}

// arm an expectation that the next matching server event should be attributed to `source`
export function armExpectation(state: State, match: ExpectationMatch, source: ArmedActionSource, ttlMs?: number) {
	state.expectations.push({ match, source, expiresAt: Date.now() + (ttlMs ?? DEFAULT_EXPECTATION_TTL_MS) })
}

// convenience wrapper for the warn case (matches on message text too, since a warnAll fans out many warns)
export function expectWarn(
	state: State,
	opts: { playerId: SM.PlayerId; reason?: string; source: ArmedActionSource; ttlMs?: number },
) {
	armExpectation(state, { type: 'PLAYER_WARNED', playerId: opts.playerId, reason: opts.reason }, opts.source, opts.ttlMs)
}

function expectationMatches(state: State, match: ExpectationMatch, event: SE.NewEvent): boolean {
	switch (match.type) {
		case 'PLAYER_WARNED':
			// warns have no organic equivalent (players don't warn each other) and never carry a native source,
			// so match on player + message text alone
			return event.type === 'PLAYER_WARNED' && event.player === match.playerId
				&& (match.reason === undefined || match.reason === event.reason)
		case 'PLAYER_KICKED':
			// kicks never carry a native source either; match on player alone
			return event.type === 'PLAYER_KICKED' && event.player === match.playerId
		case 'PLAYER_LEFT_SQUAD':
			// squad-leaves / team-changes happen organically too (inferred from team polling, source undefined). only
			// attribute an event the game already marked admin-caused -- i.e. upgrade its native source, never stamp
			// an organic one. See eventIsAdminCaused.
			return event.type === 'PLAYER_LEFT_SQUAD' && event.player === match.playerId && eventIsAdminCaused(event)
		case 'PLAYER_CHANGED_TEAM':
			return event.type === 'PLAYER_CHANGED_TEAM' && event.player === match.playerId && eventIsAdminCaused(event)
		case 'SQUAD_DISBANDED': {
			if (event.type !== 'SQUAD_DISBANDED' || !eventIsAdminCaused(event)) return false
			// the emitted event only carries the unique squad id; resolve it back to the in-game (teamId, squadId).
			// applyExpectations runs before applyEventTeamMutations so the squad is still in currTeams here.
			const squad = state.currTeams?.squads.find(s => s.uniqueId === event.uniqueId)
			return !!squad && squad.teamId === match.teamId && squad.squadId === match.squadId
		}
		case 'SQUAD_RENAMED': {
			// renames only ever come from an admin command (no organic path, no native source), so no gate
			if (event.type !== 'SQUAD_RENAMED') return false
			const squad = state.currTeams?.squads.find(s => s.uniqueId === event.uniqueId)
			return !!squad && squad.teamId === match.teamId && squad.squadId === match.squadId
		}
	}
}

// true when the game attributed this event to an admin action (it already carries a source), as opposed to an
// organic change inferred from team polling (source undefined). Guards against a stale/racing expectation stamping
// an organic squad-leave / team-change / disband. See the source assignments in the ADMIN_* handlers + reconcileTeamsUpdate.
function eventIsAdminCaused(event: SE.NewEvent): boolean {
	return (event as { source?: ActionSource }).source !== undefined
}

// stamps an emitted event with a matching armed expectation's source (consume-once). mutates the event in place.
// runs before applyEventTeamMutations so SQUAD_DISBANDED can still resolve its squad in currTeams.
function applyExpectations(state: State, event: SE.NewEvent) {
	const idx = state.expectations.findIndex(exp => expectationMatches(state, exp.match, event))
	if (idx === -1) return
	;(event as { source?: ActionSource }).source = state.expectations[idx].source
	state.expectations.splice(idx, 1)
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

// `polledAt` (ListPlayers issue time) defaults to `time` (receive time) for callers that don't distinguish the
// two -- collapsing them just reverts to receive-time boundary gating, the pre-fix behavior. Production always
// passes a distinct polledAt so an in-flight-across-a-roll response is gated correctly; see TeamsUpdateEvent.
export function onTeamsPolled(state: State, teams: SM.Teams, time: number, polledAt: number = time) {
	const lastEvent = state.eventBufs.teamsUpdates.at(-1)
	if (!!lastEvent && lastEvent.time > time) {
		throw new Error(`Teams polled with time ${time} is older than last event time ${lastEvent.time}`)
	}
	state.eventBufs.teamsUpdates.push({ type: 'TEAMS_UPDATE', id: Gen.next(state.counters.pendingEventId), teams, time, polledAt })
}

// Builds an event: stamps expectation attribution, then persists it to get its id. Called at the point each
// event is constructed, so everything from the yield onwards already carries the real (db-allocated) id.
//
// The attribution stamp belongs here rather than in the caller: `source` is part of the persisted event (and of
// its appEventId column), so stamping after the insert would silently drop it. It also has to precede
// applyEventTeamMutations (which the caller runs on the yielded event) -- SQUAD_DISBANDED resolves its squad out
// of currTeams, so the squad has to still be in there.
async function createEvent(state: State, event: SE.NewEvent): Promise<SE.Event> {
	applyExpectations(state, event)
	return await state.hooks.createEvent(event)
}

// Fold an emitted event into `state`: seed an empty roster if a roster-bearing event needs one, then apply team
// mutations. Runs on the event the generator handed over, i.e. once it is already on disk. Shared by the main
// processing loop and the watchdog resync.
function applyEventToState(state: State, ctx: CS.Log, event: SE.Event) {
	if (SE.eventRoster(event) && !state.currTeams) {
		state.currTeams = initUniqueTeams(state, { players: [], squads: [] })
	}
	if (state.currTeams) {
		applyEventTeamMutations(ctx, state.currTeams, event)
	}
}

// Watchdog recovery: re-establish sync from RCON's current layer when the log-driven roll/sync got wedged. Mirrors
// the RCON_CONNECTED sync-begin (resolve the match, enter 'syncing', emit a roster-less NEW_GAME for a new match)
// so the next teams poll produces the RESET that reseeds the roster.
async function* forceResync(state: State, time: number): AsyncGenerator<SE.Event> {
	const layersStatus = await state.hooks.fetchLayersStatus()
	if (!layersStatus) {
		state.log.warn('sync watchdog fired but fetchLayersStatus returned null; cannot force resync')
		return
	}
	const currentLayerId = layersStatus.currentLayer.id
	const { match, isNewMatch } = await state.hooks.onNewGameDuringSync(currentLayerId, time)
	state.log.warn('sync watchdog: forcing resync (stuck non-synced); layer=%s isNewMatch=%s', currentLayerId, isNewMatch)
	state.currentMatch = { historyEntryId: match.historyEntryId, layerId: match.layerId }
	state.syncState = { type: 'syncing', isNewMatch, boundaryTime: time }
	if (isNewMatch) {
		yield await createEvent(state, {
			type: 'NEW_GAME',
			layerId: state.currentMatch.layerId,
			matchId: state.currentMatch.historyEntryId,
			source: 'new-game-detected',
			time,
		})
	}
}

export async function* process(
	state: State,
	time: number,
): AsyncGenerator<SE.Event> {
	const log = state.log
	const ctx = { log, ...CS.init() }
	// GC expectations whose event never landed (matched ones are consumed on match, so this only drops stale arms)
	state.expectations = state.expectations.filter(e => e.expiresAt >= time)
	// same for attributions: a set-next whose MAP_SET never came back would otherwise sit here forever, and a later
	// set of that same layer would wrongly inherit it
	state.attributions = state.attributions.filter(a => time - a.time <= ATTRIBUTION_TTL_MS)

	// Roll/sync watchdog. While non-synced every event is dropped (see the synced gate), so a roll whose real-layer
	// NEW_GAME log never arrived would wedge us in 'rolling' indefinitely. If we've been mid-sync past the timeout,
	// force a resync from RCON's current layer; the next poll then produces the RESET that reseeds the roster.
	if (state.syncState.type === 'syncing' || state.syncState.type === 'rolling') {
		state.nonSyncedSince ??= time
		if (time - state.nonSyncedSince >= SYNC_WATCHDOG_TIMEOUT_MS) {
			state.nonSyncedSince = time // reset the clock so a failed resync retries after another full timeout, not every poll
			for await (const event of forceResync(state, time)) {
				applyEventToState(state, ctx, event)
				yield event
			}
		}
	} else {
		state.nonSyncedSince = null
	}

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
	for (let i = 0; i < toProcess.length; i++) {
		const pendingEvent = toProcess[i]
		try {
			for await (const event of processPendingEvent(state, processedEventIds, time, pendingEvent)) {
				applyEventToState(state, ctx, event)
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
			// A roster-less NEW_GAME (post-split boundary marker) leaves the roster untouched -- the following RESET
			// reseeds it. RESET, and legacy NEW_GAME-with-state, replace the roster wholesale.
			const roster = SE.eventRoster(event)
			if (!roster) break
			teams.players.splice(0, teams.players.length, ...roster.players)
			teams.squads.splice(0, teams.squads.length, ...roster.squads)
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
			const insertIndex = teams.squads.findIndex(s => s.squadId > squad.squadId)
			if (insertIndex === -1) {
				teams.squads.push(squad)
			} else {
				teams.squads.splice(insertIndex, 0, squad)
			}
			// a synthesized event carries no creation-time membership info; the join/promote events reconciled from
			// the same poll establish it instead
			if (event.synthesized) break
			// the squad is tracked even when the creator can't be resolved (they may have already left) -- refusing to
			// track it would deadlock poll reconciliation on the unknown squad. We just can't establish membership.
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

		case 'PLAYER_CONNECTED':
		// PLAYER_RECONCILED is a roster backfill (from the teams poll) and mutates the roster identically to a connect.
		case 'PLAYER_RECONCILED': {
			const existingPlayerIndex = SM.PlayerIds.indexOf(teams.players, p => p.ids, event.player.ids)
			if (existingPlayerIndex !== -1) {
				log.warn(`Player ${SM.PlayerIds.prettyPrint(event.player.ids)} ${event.type} but was already in the player list`)
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
		log.debug('Attempting to process raw event %s (%s)', pendingEvent.type, pendingEvent.id)
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
		state.syncState = { type: 'syncing', isNewMatch, boundaryTime: pendingEvent.time }
		state.currentMatch = {
			historyEntryId: match.historyEntryId,
			layerId: match.layerId,
		}

		state.isFirstConnection = state.isFirstConnection === null
		yield await createEvent(state, {
			type: 'RCON_CONNECTED',
			matchId: state.currentMatch.historyEntryId,
			time: pendingEvent.time,
			reconnected: !state.isFirstConnection,
		})

		if (
			pendingEvent.nextLayerId !== null && (state.nextLayerId === null || !L.layersEqual(state.nextLayerId, pendingEvent.nextLayerId))
		) {
			state.nextLayerId = pendingEvent.nextLayerId
			yield await createEvent(state, {
				type: 'MAP_SET',
				layerId: state.nextLayerId,
				matchId: state.currentMatch.historyEntryId,
				time: Date.now(),
			})
		}

		// Roster-less boundary marker for a genuinely new match; the roster follows on the first post-boundary poll
		// (RESET). A same-match reconnect (isNewMatch=false) emits no NEW_GAME -- just the RESET reseed.
		if (isNewMatch) {
			yield await createEvent(state, {
				type: 'NEW_GAME',
				layerId: state.currentMatch.layerId,
				matchId: state.currentMatch.historyEntryId,
				source: state.isFirstConnection ? 'slm-started' : 'rcon-reconnected',
				time: pendingEvent.time,
			})
		}
	}

	if (pendingEvent.type === 'RCON_DISCONNECTED') {
		if (state.syncState.type !== 'rolling') {
			state.syncState = { type: 'desynced' }
		}
		if (state.currTeams && state.currentMatch !== 'PENDING') {
			state.staleTeamsFromDisconnect = { matchId: state.currentMatch.historyEntryId, teams: state.currTeams }
		}
		state.currTeams = null
		// team state is gone; any pending forced-team-change attribution can no longer be matched to a poll
		state.forcedTeamChanges.clear()
		state.pollAbsenceStreaks.clear()
		state.unknownSquadStreaks.clear()
		state.unassignedPlayers.clear()
		if (state.currentMatch !== 'PENDING') {
			yield await createEvent(state, {
				type: 'RCON_DISCONNECTED',
				time: pendingEvent.time,
				matchId: state.currentMatch.historyEntryId,
			})
		}
	}

	outerIf: if (pendingEvent.type === 'TEAMS_UPDATE' && state.syncState.type === 'syncing') {
		if (state.currentMatch === 'PENDING') throw new Error('Unexpected missing current match')
		// Discard polls captured before the boundary (a previous match / pre-connect snapshot). Gated on receive
		// time, not polledAt: unlike a roll, a sync boundary isn't straddled by an in-flight poll on the same
		// connection -- initial sync has no prior roster (currTeams is null) and a reconnect drops the socket, so any
		// pre-disconnect response fails rather than arriving late. Using polledAt here would only risk discarding the
		// first genuine post-connect poll (its request can be issued a hair before boundaryTime) and stalling sync.
		if (pendingEvent.time < state.syncState.boundaryTime) break outerIf
		// Snapshot only players already assigned to a team. We used to require EVERY listed player to be teamed,
		// which let a single still-loading/spectating straggler defer sync indefinitely and widen the window in
		// which connects are dropped. Team-less stragglers are instead added later by reconcileTeamsUpdate as they
		// get sorted onto a team. Only defer a poll that has players but none teamed yet (a purely transitional
		// snapshot); an empty server (no players at all) still syncs.
		const teamedPlayers = pendingEvent.teams.players.filter(p => p.teamId != null)
		if (pendingEvent.teams.players.length > 0 && teamedPlayers.length === 0) break outerIf
		const stale = state.staleTeamsFromDisconnect
		state.staleTeamsFromDisconnect = null
		const prior = stale ? { teams: stale.teams, sameMatch: stale.matchId === state.currentMatch.historyEntryId } : undefined
		const teams = initUniqueTeams(state, { players: teamedPlayers, squads: pendingEvent.teams.squads }, prior)

		// The definitive roster always arrives via RESET. For a new match the roster-less NEW_GAME boundary was
		// already emitted at RCON_CONNECTED; a same-match reconnect emits only this RESET.
		yield await createEvent(state, {
			type: 'RESET',
			matchId: state.currentMatch.historyEntryId,
			state: teams,
			time: pendingEvent.time,
			source: state.isFirstConnection ? 'slm-started' : 'rcon-reconnected',
		})
		state.syncState = { type: 'synced' }
	}

	outerIf: if (
		pendingEvent.type === 'TEAMS_UPDATE' && state.syncState.type === 'rolling' && !!state.syncState.newGameEvent
		// polledAt (issue time), not receive time: the roll completes only on a poll definitely issued after the
		// destination NEW_GAME, so a response that was in flight across the roll (pre-roll roster, received after the
		// boundary) can't complete it. It falls through to the non-synced drop below; the next poll finishes the roll.
		&& state.syncState.newGameEvent.time < pendingEvent.polledAt
		&& state.currentMatch !== 'PENDING'
	) {
		// See the syncing branch above: snapshot the teamed players, don't stall on team-less stragglers.
		const teamedPlayers = pendingEvent.teams.players.filter(p => p.teamId != null)
		if (pendingEvent.teams.players.length > 0 && teamedPlayers.length === 0) break outerIf

		// the stale pre-roll roster is a different match (never reuse squad ids), but its name-derived player ids carry over
		const prior = state.currTeams ? { teams: state.currTeams, sameMatch: false } : undefined
		const teams = initUniqueTeams(state, { players: teamedPlayers, squads: pendingEvent.teams.squads }, prior)
		// The roster-less NEW_GAME(server-roll) boundary was emitted when the real-layer NEW_GAME log arrived; this
		// first post-boundary poll carries the definitive roster as a RESET. The reducer applies it to currTeams.
		yield await createEvent(state, {
			type: 'RESET',
			time: pendingEvent.time,
			matchId: state.currentMatch.historyEntryId,
			state: teams,
			source: 'server-roll',
		})
		state.syncState = { type: 'synced' }
	}

	if (pendingEvent.type === 'NEW_GAME') {
		if (pendingEvent.layerClassname === 'TransitionMap') {
			state.syncState = { type: 'rolling' }
			// Keep the prior roster as a stale fallback through the roll instead of nulling it. syncState==='rolling'
			// is the staleness marker, and the post-roll NEW_GAME snapshot replaces it wholesale once sync completes.
			// This preserves attribution lookups (getCurrTeams) across the loading screen and avoids a total blackout
			// if the roll never completes. The absence streaks and unassigned set belong to the outgoing roster, reset them.
			state.pollAbsenceStreaks.clear()
			state.unknownSquadStreaks.clear()
			state.unassignedPlayers.clear()
			state.expectedNewLayerId = state.nextLayerId
			log.debug('Received TransitionMap NEW_GAME. syncState: rolling')
		} else {
			// Enter 'rolling' but do NOT commit `newGameEvent` yet. The rolling TEAMS_UPDATE branch keys off
			// `newGameEvent` (and only guards `currentMatch !== 'PENDING'`), so committing it before we've resolved
			// the new match would let the next poll complete the roll against the stale (previous) match.
			state.syncState = { type: 'rolling' }
			let newLayerId = state.expectedNewLayerId
			state.expectedNewLayerId = null
			if (!newLayerId || !L.layerMatchesIngameLayerClassname(newLayerId, pendingEvent.layerClassname)) {
				if (pendingEvent.layerClassname) {
					log.error(`layerClassname mismatch: expected ${newLayerId}, got ${pendingEvent.layerClassname}`)
				} else {
					log.warn('expectedNewLayerId is null')
				}
				const layersStatus = await state.hooks.fetchLayersStatus()
				if (!layersStatus) {
					// Couldn't resolve the new layer. Stay in plain 'rolling' (no newGameEvent) so the roll can't
					// complete against a stale match; the sync watchdog force-resyncs from RCON if this persists.
					log.warn('fetchLayersStatus returned null; staying in rolling for the watchdog to recover')
					processedEventIds.add(pendingEvent.id)
					return
				}
				log.debug({ layerId: layersStatus.currentLayer.id }, 'found new layer during roll')
				newLayerId = layersStatus.currentLayer.id
			}

			const { match, nextLayerId } = await state.hooks.onNewGameDuringRoll(newLayerId, pendingEvent.time)
			state.currentMatch = {
				historyEntryId: match.historyEntryId,
				layerId: match.layerId,
			}
			if (nextLayerId !== null) {
				// we don't emit a MAP_SET event here as we've assumd the caller has already handled this logic in onNewGameDuringRoll
				state.nextLayerId = nextLayerId
			}
			// Match resolved: now commit newGameEvent so the next post-boundary poll produces the RESET.
			state.syncState = { type: 'rolling', newGameEvent: pendingEvent }

			// Roster-less boundary marker, emitted promptly at the real-layer log. The roster follows on the first
			// teams poll timestamped after this (see the rolling TEAMS_UPDATE branch), as a RESET.
			yield await createEvent(state, {
				type: 'NEW_GAME',
				layerId: state.currentMatch.layerId,
				matchId: state.currentMatch.historyEntryId,
				source: 'server-roll',
				time: pendingEvent.time,
			})
		}
	}

	if (state.syncState.type !== 'synced' || state.currentMatch === 'PENDING') {
		processedEventIds.add(pendingEvent.id)
		return
	}
	if (!state.currTeams) throw new Error('currTeams is null when synced')

	const base = {
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
			// match on the layer, not on position: a set-next whose MAP_SET never landed (or landed before its own
			// attribution did) leaves an attribution behind, and taking that one here would consume it AND leave this
			// event unattributed -- which is what made a stale attribution poison the next map set
			const attributionIndex = state.attributions.findIndex(a =>
				a.type === 'MAP_SET_ATTRIBUTION' && L.areLayersCompatible(a.layerId, layer.id)
			)
			if (attributionIndex !== -1) {
				const attribution = state.attributions[attributionIndex]
				source = attribution.appEventId
					? { type: 'event', id: attribution.appEventId }
					: { type: 'layer-queue', itemId: attribution.itemId }
				state.attributions.splice(attributionIndex, 1)
			}
			yield await createEvent(state, {
				type: 'MAP_SET',
				...base,
				layerId: layer.id,
				source,
			})
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

			const roundEnded: Types.DistributiveOmit<SE.RoundEnded, 'id'> = {
				type: 'ROUND_ENDED',
				outcome,
				action: action,
				...base,
			}

			yield await createEvent(state, roundEnded)

			break
		}

		case 'PLAYER_KICKED_CHAIN': {
			const events = pendingEvent.events
			yield await createEvent(state, {
				...base,
				type: 'PLAYER_KICKED',
				player: SM.PlayerIds.getPlayerId(events.PLAYER_KICKED.playerIds),
				reason: events.KICKING_PLAYER.reason,
			})
			break
		}

		// carryover from squadjs, no recent instances of this in current prod logs
		case 'PLAYER_BANNED': {
			yield await createEvent(state, {
				...base,
				type: 'PLAYER_BANNED',
				player: SM.PlayerIds.getPlayerId(pendingEvent.playerIds),
				interval: pendingEvent.interval,
			})
			break
		}

		case 'PLAYER_WARNED': {
			const player = SM.PlayerIds.find(state.currTeams.players, p => p.ids, pendingEvent.playerIds)
			if (!player) {
				log.error('Player not found in currTeams: %s', SM.PlayerIds.prettyPrint(pendingEvent.playerIds))
				break
			}
			yield await createEvent(state, {
				...base,
				type: 'PLAYER_WARNED',
				reason: pendingEvent.reason,
				player: SM.PlayerIds.getPlayerId(player.ids),
			})
			break
		}

		case 'POSSESSED_ADMIN_CAMERA': {
			yield await createEvent(state, {
				...base,
				type: 'POSSESSED_ADMIN_CAMERA',
				player: SM.PlayerIds.getPlayerId(pendingEvent.playerIds),
			})
			break
		}

		case 'UNPOSSESSED_ADMIN_CAMERA': {
			yield await createEvent(state, {
				...base,
				type: 'UNPOSSESSED_ADMIN_CAMERA',
				player: SM.PlayerIds.getPlayerId(pendingEvent.playerIds),
			})
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
				// the log stream carries no admin-list membership; the next RCON teams poll fills both this and isAdmin in
				adminGroups: [],
				role: 'unknown',
			}

			yield await createEvent(state, {
				type: 'PLAYER_CONNECTED',
				...base,
				player: Obj.deepClone(player),
			})
			break
		}

		case 'SQUAD_CREATED': {
			const factionId = L.getFactionIdForFactionNameInexact(pendingEvent.teamName)
			if (!factionId) {
				log.error(`unable to resolve faction id for team name ${pendingEvent.teamName}; the squad will be synthesized from a teams poll`)
				break
			}
			const layer = L.toLayer(state.currentMatch.layerId)

			let teamId: SM.TeamId
			if (layer.Faction_1 && layer.Faction_1 === factionId) {
				teamId = 1
			} else if (layer.Faction_2 && layer.Faction_2 === factionId) {
				teamId = 2
			} else {
				log.error(
					`unable to resolve team id for squad created with team name ${pendingEvent.teamName} (factionId=${factionId}); the squad will be synthesized from a teams poll`,
				)
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
			const existingSquad = state.currTeams.squads.find(s => SM.Squads.idsEqual(s, squad))
			if (existingSquad) {
				for (const player of state.currTeams.players) {
					if (!SM.Squads.idsEqual(player, squad)) continue
					yield await createEvent(state, {
						type: 'PLAYER_LEFT_SQUAD',
						player: SM.PlayerIds.getPlayerId(player.ids),
						uniqueId: existingSquad.uniqueId,
						matchId: state.currentMatch.historyEntryId,
						time: pendingEvent.time,
					})
				}

				yield await createEvent(state, {
					type: 'SQUAD_DISBANDED',
					uniqueId: existingSquad.uniqueId,
					matchId: state.currentMatch.historyEntryId,
					time: pendingEvent.time,
				})
			}

			if (player) {
				if (player.squadId && (!existingSquad || !SM.Squads.idsEqual(player, existingSquad))) {
					const playerSquad = state.currTeams.squads.find(s => SM.Squads.idsEqual(s, player))
					if (playerSquad) {
						yield* emitLeaveSquadEvents(state as StateWithCurrentMatchAndPlayers, pendingEvent.time, player, playerSquad.uniqueId)
					} else {
						log.warn(
							`Player ${
								SM.PlayerIds.prettyPrint(player.ids)
							} is in a squad (${player.squadId}) but no squad was found in the current teams`,
						)
					}
				}

				if (player.teamId !== teamId) {
					yield await createEvent(state, {
						type: 'PLAYER_CHANGED_TEAM',
						player: SM.PlayerIds.getPlayerId(player.ids),
						newTeamId: teamId,
						time: pendingEvent.time,
						matchId: state.currentMatch.historyEntryId,
					})
				}
			} else {
				// the creator not being in currTeams yet (e.g. their connect was missed) is no reason to drop the
				// squad; emit without the membership side effects and let poll reconciliation establish them
				log.warn(
					'SQUAD_CREATED: creator %s not found in currTeams; emitting without membership side effects',
					SM.PlayerIds.prettyPrint(pendingEvent.creatorIds),
				)
			}

			yield await createEvent(state, {
				type: 'SQUAD_CREATED',
				squad: squad,
				...base,
			})

			break
		}

		case 'PLAYER_DISCONNECTED': {
			if (!state.currTeams) break
			const player = SM.PlayerIds.find(state.currTeams.players, p => p.ids, pendingEvent.playerIds)
			if (player) {
				if (player.squadId) {
					const squad = state.currTeams.squads.find(s => SM.Squads.idsEqual(s, player))
					if (squad) {
						yield* emitLeaveSquadEvents(state as StateWithCurrentMatchAndPlayers, pendingEvent.time, player, squad.uniqueId)
					} else {
						log.warn(`Squad not found for disconnecting player: ${SM.PlayerIds.prettyPrint(player.ids)}`)
					}
				}
			} else {
				log.warn(`Player not found on disconnect: ${SM.PlayerIds.prettyPrint(pendingEvent.playerIds)}`)
				break
			}
			yield await createEvent(state, {
				type: 'PLAYER_DISCONNECTED',
				player: SM.PlayerIds.getPlayerId(pendingEvent.playerIds),
				...base,
			})
			break
		}

		case 'SQUAD_RENAMED': {
			const squad = state.currTeams.squads.find(s => s.squadId === pendingEvent.squadId && s.teamId === pendingEvent.teamId)
			if (!squad) {
				log.error('SQUAD_RENAMED: squad not found for squadId=%d, teamId=%d', pendingEvent.squadId, pendingEvent.teamId)
				break
			}
			yield await createEvent(state, {
				type: 'SQUAD_RENAMED',
				uniqueId: squad.uniqueId,
				oldSquadName: pendingEvent.oldSquadName,
				newSquadName: pendingEvent.newSquadName,
				...base,
			})
			break
		}

		case 'ADMIN_FORCED_TEAM_CHANGE': {
			// The log doesn't state the destination team, and firing early races the teams poll -- which is the real
			// source of truth for the new team and the implied squad-leave. So just record the admin attribution;
			// the next teams poll's PLAYER_CHANGED_TEAM picks it up. See reconcileTeamsUpdate / the TEAMS_UPDATE case,
			// which wipes forcedTeamChanges after every poll (used or not).
			state.forcedTeamChanges.set(SM.PlayerIds.getPlayerId(pendingEvent.playerIds), pendingEvent.source)
			break
		}

		case 'ADMIN_DISBANDED_SQUAD': {
			const squad = state.currTeams.squads.find(s => s.squadId === pendingEvent.squadId && s.teamId === pendingEvent.teamId)
			if (!squad) {
				log.warn('Disband for unknown squad: squadId=%d, teamId=%d', pendingEvent.squadId, pendingEvent.teamId)
				break
			}
			for (const player of state.currTeams.players) {
				if (!SM.Squads.idsEqual(player, squad)) continue
				yield await createEvent(state, {
					type: 'PLAYER_LEFT_SQUAD',
					player: SM.PlayerIds.getPlayerId(player.ids),
					uniqueId: squad.uniqueId,
					matchId: state.currentMatch.historyEntryId,
					time: pendingEvent.time,
					source: pendingEvent.source,
				})
			}
			yield await createEvent(state, {
				type: 'SQUAD_DISBANDED',
				...base,
				uniqueId: squad.uniqueId,
				source: pendingEvent.source,
			})
			break
		}

		case 'ADMIN_REMOVED_FROM_SQUAD': {
			// the log only carries a display name, so resolution is by username; if it's ambiguous/unknown we skip and
			// let the teams poll reconcile the leave organically (without attribution)
			const player = SM.PlayerIds.find(state.currTeams.players, p => p.ids, pendingEvent.playerIds)
			if (!player) {
				log.warn('Remove from squad for unknown player: %s', SM.PlayerIds.prettyPrint(pendingEvent.playerIds))
				break
			}
			if (!player.squadId) {
				log.warn('Remove from squad for player not in a squad: %s', SM.PlayerIds.prettyPrint(player.ids))
				break
			}
			const squad = state.currTeams.squads.find(s => SM.Squads.idsEqual(s, player))
			if (!squad) {
				log.warn("Remove from squad but player's squad not found in currTeams: %s", SM.PlayerIds.prettyPrint(player.ids))
				break
			}
			yield* emitLeaveSquadEvents(state as StateWithCurrentMatchAndPlayers, pendingEvent.time, player, squad.uniqueId, pendingEvent.source)
			break
		}

		case 'TEAMS_UPDATE': {
			// drained before any of it is yielded, as it always has been: every event the reconciler produces is
			// computed against the pre-mutation roster, and the caller only mutates once we hand an event over
			const events: SE.Event[] = []
			for await (const event of reconcileTeamsUpdate(state, pendingEvent)) events.push(event)
			yield* events
			// a forced-team-change attribution is valid for exactly one poll -- discard whatever wasn't consumed
			state.forcedTeamChanges.clear()
			break
		}

		case 'PLAYER_DIED':
		case 'PLAYER_WOUNDED': {
			// the log identifies the victim by display name only, which can carry a clan tag the RCON roster name
			// lacks; fall back to a loose unique match rather than dropping the event
			let victim = SM.PlayerIds.find(state.currTeams.players, p => p.ids, pendingEvent.victimIds)
			if (!victim && pendingEvent.victimIds.username) {
				victim = SM.PlayerIds.findByUsernameLoose(state.currTeams.players, p => p.ids, pendingEvent.victimIds.username)
				if (victim) {
					log.debug(
						'resolved %s victim "%s" via loose username match -> %s',
						pendingEvent.type,
						pendingEvent.victimIds.username,
						SM.PlayerIds.prettyPrint(victim.ids),
					)
				}
			}
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

			yield await createEvent(state, {
				type: pendingEvent.type,
				...base,
				damage: pendingEvent.damage,
				weapon: pendingEvent.weapon,
				variant,
				attacker: SM.PlayerIds.getPlayerId(attacker.ids),
				victim: SM.PlayerIds.getPlayerId(victim.ids),
			})

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

			yield await createEvent(state, {
				type: 'CHAT_MESSAGE',
				message: pendingEvent.message,
				player: SM.PlayerIds.getPlayerId(pendingEvent.playerIds),
				channel,
				...base,
			})
			break
		}

		case 'ADMIN_BROADCAST': {
			yield await createEvent(state, {
				type: 'ADMIN_BROADCAST',
				message: pendingEvent.message,
				source: pendingEvent.source,
				...base,
			})
			break
		}
	}

	processedEventIds.add(pendingEvent.id)
}

async function* reconcileTeamsUpdate(state: State, event: TeamsUpdateEvent): AsyncGenerator<SE.Event> {
	const nextTeams = event.teams
	if (!state.currTeams || state.currentMatch === 'PENDING') return
	const nextSquads: SM.UniqueSquad[] = []
	const base = { matchId: state.currentMatch.historyEntryId, time: event.time }
	const log = state.log

	let emittedEvent = false

	// RCON ListPlayers is authoritative on presence, so it drives both add and remove here. Log connect/disconnect
	// lines still handle the common case with precise timing; this reconcile is the backstop that keeps currTeams
	// converged with reality when a log line is missed, malformed, or dropped (e.g. a connect that landed during a
	// round roll while currTeams was null, or a disconnect whose log line never arrived). Both loops run before the
	// squad-match early-return so presence recovery is never blocked by a not-yet-created squad.

	// ADD: a polled player absent from currTeams is added here. currTeams stays teamed-only, so team-less players
	// aren't added yet -- they're tracked in `unassignedPlayers` (rebuilt below) and added on the poll where they
	// first appear teamed, which also avoids a spurious PLAYER_CHANGED_TEAM. A newly-teamed player we had already
	// seen team-less is a backfill of someone we were tracking -> PLAYER_RECONCILED (not surfaced as a fresh join);
	// one we had never seen genuinely connected while we weren't watching (e.g. their connect log dropped during a
	// roll) -> PLAYER_CONNECTED. Squad/leader state is then established by the reconciliation loops below.
	const prevUnassigned = state.unassignedPlayers
	const nextUnassigned = new Set<SM.PlayerId>()
	for (const nextPlayer of nextTeams.players) {
		const playerId = SM.PlayerIds.getPlayerId(nextPlayer.ids)
		const inCurrTeams = !!SM.PlayerIds.find(state.currTeams.players, p => p.ids, nextPlayer.ids)
		if (nextPlayer.teamId == null) {
			if (!inCurrTeams) nextUnassigned.add(playerId)
			continue
		}
		if (inCurrTeams) continue
		emittedEvent = true
		yield await createEvent(state, {
			type: prevUnassigned.has(playerId) ? 'PLAYER_RECONCILED' : 'PLAYER_CONNECTED',
			player: {
				ids: nextPlayer.ids,
				teamId: nextPlayer.teamId,
				squadId: null,
				isLeader: false,
				isAdmin: nextPlayer.isAdmin,
				adminGroups: nextPlayer.adminGroups,
				role: nextPlayer.role,
			},
			...base,
		})
	}
	state.unassignedPlayers = nextUnassigned

	// REMOVE: a player in currTeams absent from the poll has a missed disconnect. Debounce across polls
	// (POLL_ABSENCE_CULL_THRESHOLD) so a single dropped/partial poll never evicts a still-connected player.
	for (const player of state.currTeams.players) {
		const playerId = SM.PlayerIds.getPlayerId(player.ids)
		if (SM.PlayerIds.find(nextTeams.players, p => p.ids, player.ids)) {
			state.pollAbsenceStreaks.delete(playerId)
			continue
		}
		const streak = (state.pollAbsenceStreaks.get(playerId) ?? 0) + 1
		if (streak < POLL_ABSENCE_CULL_THRESHOLD) {
			state.pollAbsenceStreaks.set(playerId, streak)
			continue
		}
		state.pollAbsenceStreaks.delete(playerId)
		emittedEvent = true
		yield await createEvent(state, {
			type: 'PLAYER_DISCONNECTED',
			player: playerId,
			...base,
		})
	}

	// we want the SQUAD_CREATED event to have always landed before attempting to process teams updates, so an unknown
	// squad skips the cycle for a few polls to give the log pipeline time to deliver it. If it still hasn't landed
	// (missed/unparseable/dropped log), the poll is authoritative at that point: synthesize the SQUAD_CREATED from
	// poll data rather than blocking all team updates until the next RESET.
	const currentUnknownSquadKeys = new Set<string>()
	let awaitingSquadCreated = false
	for (const squad of nextTeams.squads) {
		const prevSquad = state.currTeams.squads.find(s => SM.Squads.idsEqual(s, squad) && s.creator === squad.creator)
		if (prevSquad) {
			nextSquads.push({
				...squad,
				uniqueId: prevSquad.uniqueId,
			})
			continue
		}
		const key = `${SM.Squads.printKey(squad)}:${squad.creator}`
		currentUnknownSquadKeys.add(key)
		const streak = (state.unknownSquadStreaks.get(key) ?? 0) + 1
		if (streak < UNKNOWN_SQUAD_SYNTHESIS_THRESHOLD) {
			state.unknownSquadStreaks.set(key, streak)
			log.debug('Squad not found for update: %s (streak %d), skipping update cycle', SM.Squads.printKey(squad), streak)
			awaitingSquadCreated = true
			continue
		}
		state.unknownSquadStreaks.delete(key)
		const uniqueSquad: SM.UniqueSquad = { ...Obj.deepClone(squad), uniqueId: Gen.next(state.counters.squadId) }
		log.warn(
			'No SQUAD_CREATED landed for squad %s after %d polls; synthesizing it from the teams poll',
			SM.Squads.printKey(squad),
			UNKNOWN_SQUAD_SYNTHESIS_THRESHOLD,
		)
		emittedEvent = true
		yield await createEvent(state, {
			type: 'SQUAD_CREATED',
			squad: uniqueSquad,
			synthesized: true,
			...base,
		})
		nextSquads.push(uniqueSquad)
	}
	// entries for squads that matched or vanished this poll are stale
	for (const key of state.unknownSquadStreaks.keys()) {
		if (!currentUnknownSquadKeys.has(key)) state.unknownSquadStreaks.delete(key)
	}
	if (awaitingSquadCreated) return

	for (const nextPlayer of nextTeams.players) {
		const playerId = SM.PlayerIds.getPlayerId(nextPlayer.ids)
		const currPlayer = SM.PlayerIds.find(state.currTeams.players, p => p.ids, nextPlayer.ids)
		const squad = nextPlayer.squadId && nextSquads.find(s => SM.Squads.idsEqual(s, nextPlayer))
		const currSquad = currPlayer?.squadId
			&& state.currTeams.squads.find(s => SM.Squads.idsEqual(s, { squadId: currPlayer.squadId, teamId: currPlayer.teamId }))

		if (currSquad && (!squad || currSquad.uniqueId !== squad.uniqueId)) {
			// currPlayer.squadId = null
			emittedEvent = true
			yield await createEvent(state, {
				type: 'PLAYER_LEFT_SQUAD',
				player: playerId,
				uniqueId: currSquad.uniqueId,
				...base,
			})
		}
	}

	const disbandedSquads = new Set<number>()
	for (const currSquad of state.currTeams.squads) {
		const nextSquad = nextSquads.find(s => s.uniqueId === currSquad.uniqueId)
		if (!nextSquad) {
			disbandedSquads.add(currSquad.uniqueId)
			emittedEvent = true
			yield await createEvent(state, {
				type: 'SQUAD_DISBANDED',
				uniqueId: currSquad.uniqueId,
				...base,
			})
			continue
		}

		const details = Obj.selectProps(nextSquad, SM.SQUAD_DETAILS)
		const prevDetails = Obj.selectProps(currSquad, SM.SQUAD_DETAILS)
		if (!Obj.deepEqual(details, prevDetails)) {
			emittedEvent = true
			yield await createEvent(state, {
				type: 'SQUAD_DETAILS_CHANGED',
				uniqueId: currSquad.uniqueId,
				details,
				...base,
			})
		}
	}

	for (const nextPlayer of nextTeams.players) {
		const playerId = SM.PlayerIds.getPlayerId(nextPlayer.ids)
		const currPlayer = SM.PlayerIds.find(state.currTeams.players, p => p.ids, nextPlayer.ids)

		if (currPlayer && nextPlayer.teamId !== currPlayer.teamId) {
			emittedEvent = true
			yield await createEvent(state, {
				type: 'PLAYER_CHANGED_TEAM',
				player: playerId,
				newTeamId: nextPlayer.teamId,
				// attributed if an admin forced this change (recorded from the log); undefined for organic switches
				source: state.forcedTeamChanges.get(playerId),
				...base,
			})
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
				yield await createEvent(state, {
					type: 'PLAYER_JOINED_SQUAD',
					uniqueId: squad.uniqueId,
					player: playerId,
					...base,
				})
			}

			if (player.isLeader && !prevPlayer?.isLeader) {
				if (!player.squadId) {
					log.warn('Attempted to promote player leader but has no squad: %s', playerId)
					return
				}
				emittedEvent = true
				yield await createEvent(state, {
					type: 'PLAYER_PROMOTED_TO_LEADER',
					uniqueId: squad.uniqueId,
					player: playerId,
					...base,
				})
			}
		}

		if (prevPlayer) {
			const details = Obj.selectProps(player, SM.PLAYER_DETAILS)
			const prevDetails = Obj.selectProps(prevPlayer, SM.PLAYER_DETAILS)
			const newUsername = prevPlayer.ids.username !== player.ids.username ? player.ids.username : undefined
			if (!Obj.deepEqual(details, prevDetails) || newUsername) {
				emittedEvent = true
				yield await createEvent(
					state,
					{
						type: 'PLAYER_DETAILS_CHANGED',
						player: SM.PlayerIds.getPlayerId(player.ids),
						details,
						newUsername,
						...base,
					} satisfies Types.DistributiveOmit<SE.PlayerDetailsChanged, 'id'>,
				)
			}
		}
	}
	if (emittedEvent) {
		yield await createEvent(state, {
			type: 'TEAMS_POLLED_UPDATE',
			matchId: state.currentMatch.historyEntryId,
			time: event.time,
		})
	}
}

async function* emitLeaveSquadEvents(
	state: StateWithCurrentMatchAndPlayers,
	time: number,
	player: SM.Player,
	squadUniqueId: number,
	source?: SM.LogEvents.ActionSource,
): AsyncGenerator<SE.Event> {
	if (player.squadId) {
		yield await createEvent(state, {
			type: 'PLAYER_LEFT_SQUAD',
			player: SM.PlayerIds.getPlayerId(player.ids),
			uniqueId: squadUniqueId,
			time,
			matchId: state.currentMatch.historyEntryId,
			source,
		})
		const otherPlayers: SM.Player[] = []
		for (const otherPlayer of state.currTeams.players) {
			if (SM.Squads.idsEqual(otherPlayer, player) && !SM.PlayerIds.match(player.ids, otherPlayer.ids)) {
				otherPlayers.push(otherPlayer)
			}
		}
		if (otherPlayers.length === 0) {
			yield await createEvent(state, {
				type: 'SQUAD_DISBANDED',
				uniqueId: squadUniqueId,
				time,
				matchId: state.currentMatch.historyEntryId,
				source,
			})
		} else if (otherPlayers.length === 1) {
			const otherPlayer = otherPlayers[0]
			if (player.isLeader) {
				yield await createEvent(state, {
					type: 'PLAYER_PROMOTED_TO_LEADER',
					player: SM.PlayerIds.getPlayerId(otherPlayer.ids),
					uniqueId: squadUniqueId,
					time,
					matchId: state.currentMatch.historyEntryId,
				})
			}
		}
	}
}

// `prior` (when available) carries identity across a reseed that RCON polls can't provide: usernameNoTag gathered
// from join logs, and, for a same-match reseed (RCON blip), squad uniqueIds -- so a reconnect doesn't make every
// squad look recreated.
function initUniqueTeams(state: State, teams: SM.Teams, prior?: { teams: SM.UniqueTeams; sameMatch: boolean }) {
	const players = teams.players.map(p => {
		const prev = prior && SM.PlayerIds.find(prior.teams.players, pp => pp.ids, p.ids)
		// only trust the cached name-derived id if the username is unchanged
		if (!prev?.ids.usernameNoTag || prev.ids.username !== p.ids.username) return p
		return { ...p, ids: { usernameNoTag: prev.ids.usernameNoTag, ...p.ids } }
	})
	const uniqueSquads: SM.UniqueSquad[] = teams.squads.map(s => {
		const prev = prior?.sameMatch
			? prior.teams.squads.find(ps => SM.Squads.idsEqual(ps, s) && ps.creator === s.creator)
			: undefined
		return {
			...Obj.deepClone(s),
			uniqueId: prev?.uniqueId ?? Gen.next(state.counters.squadId),
		}
	})
	const uniqueTeams: SM.UniqueTeams = { ...teams, players, squads: Obj.deepClone(uniqueSquads) }
	return uniqueTeams
}
