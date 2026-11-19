import type Database from 'better-sqlite3'
import * as E from 'drizzle-orm'

import * as Schema from '$root/drizzle/schema.ts'
import * as Gen from '@/lib/generator-utils'
import { matchLog } from '@/lib/log-parsing'
import * as CS from '@/models/context-shared.models'
import * as L from '@/models/layer.models'
import * as MH from '@/models/match-history.models'
import * as PendingEvents from '@/models/pending-events.models'
import * as SM from '@/models/squad.models'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import * as Sql from '@/server/sql'
import * as EventWrites from '@/systems/server-event-writes.server'

import { World } from '../emulator'
import type * as Fmt from '../emulator/format'
import { TICK_MS, WorldDriver } from './world-driver'

// Fills a database with match history the way the live ingest would have written it: each match is played out by a
// WorldDriver on a fake clock, and its log, chat and rosters are replayed through PendingEvents into
// EventWrites.insertEvent. The matches run back to back and end at `endAt`, so the app's archive compaction ages them
// as it would real ones.

export type SeedOptions = {
	driver: Database.Database
	serverIds: string[]
	matchesPerServer: number
	players: number
	populationPool: number
	matchDurationMs: number
	chatPerMinute: number
	endAt: number
	log: (line: string) => void
}

const SQL = Sql.forModule(initModule('load-seed'))

namespace Q {
	const serverP = SQL.params({ serverId: Schema.matchHistory.serverId })
	export const lastOrdinal = SQL.def(
		'lastOrdinal',
		serverP,
		SQL.select({ ordinal: Schema.matchHistory.ordinal })
			.from(Schema.matchHistory)
			.where(E.eq(Schema.matchHistory.serverId, serverP.serverId))
			.orderBy(E.desc(Schema.matchHistory.ordinal))
			.limit(1),
	)
	const finalizeP = SQL.params({
		id: Schema.matchHistory.id,
		endTime: Schema.matchHistory.endTime,
		outcome: Schema.matchHistory.outcome,
		team1Tickets: Schema.matchHistory.team1Tickets,
		team2Tickets: Schema.matchHistory.team2Tickets,
	})
	export const finalizeMatch = SQL.def(
		'finalizeMatch',
		finalizeP,
		SQL.update(Schema.matchHistory)
			.set({
				endTime: finalizeP.endTime,
				outcome: finalizeP.outcome,
				team1Tickets: finalizeP.team1Tickets,
				team2Tickets: finalizeP.team2Tickets,
			})
			.where(E.eq(Schema.matchHistory.id, finalizeP.id)),
	)
}

const POLL_INTERVAL_MS = 5_000
const END_OF_MATCH_LINE = 'LogGameMode: Display: Match State Changed from InProgress to WaitingPostMatch'
const POST_MATCH_MS = 30_000
// The live ingest reads the log once a second (logFilePollInterval) and processes what it read in slices of 50. A
// slice that spanned longer would be processed so long after its first event that the pipeline drops it as stale,
// which is what happens to a NEW_GAME in the quiet between matches.
const SLICE = 50
const DELIVERY_MS = 1_000
// as the bench replay does: each line is delivered this long after it was written
const DELIVERY_LAG_MS = 100
const ROTATION = [
	'Narva_RAAS_v1 USA+CombinedArms RGF+CombinedArms',
	'Gorodok_RAAS_v1 USA+CombinedArms RGF+CombinedArms',
	'Skorpo_RAAS_v1 USA+CombinedArms RGF+CombinedArms',
	'Harju_RAAS_v1 RGF+Mechanized PLA+AirAssault',
	'Sumari_RAAS_v1 ADF+CombinedArms USA+CombinedArms',
]

const noop = () => {}
const quietLog: CS.Logger = {
	info: noop,
	warn: noop,
	error: noop,
	debug: noop,
	trace: noop,
	fatal: noop,
	child: () => quietLog,
} as unknown as CS.Logger

type Played = {
	lines: string[]
	chats: SM.RconEvents.Event[]
	polls: { time: number; teams: SM.Teams }[]
	winnerTeamId: number
	tickets: [number, number]
	endedAt: number
}

export async function seed(opts: SeedOptions) {
	opts.driver.pragma('synchronous = OFF')
	const dbCtx = { ...CS.init(), db: DB.connect(opts.driver), log: quietLog }
	const matchSpan = opts.matchDurationMs + POST_MATCH_MS
	let events = 0
	for (const serverId of opts.serverIds) {
		let clock = opts.endAt - opts.matchesPerServer * matchSpan
		let winner = 1
		const world = new World(
			{
				chatPacket: (body) => {
					const [event] = matchLog(body, SM.RCON_EVENT_MATCHERS)
					if (event) current.chats.push({ ...event, time: clock } as SM.RconEvents.Event)
				},
				logLine: (line) => current.lines.push(line),
				layerChangeRequested: noop,
				matchEnded: noop,
			},
			{ serverName: serverId, idSalt: serverId, now: () => new Date(clock) },
		)
		let ended = false
		const driver = new WorldDriver(
			{
				world,
				endMatchAndRoll: (o) => {
					winner = o?.winnerTeamId ?? 1
					world.endMatch(o)
					ended = true
				},
			},
			{
				players: opts.players,
				intensity: 1,
				populationPool: opts.populationPool,
				matchDurationMs: opts.matchDurationMs,
				chatPerMinute: opts.chatPerMinute,
				salt: serverId,
				now: () => clock,
			},
		)
		let current: Played = { lines: [], chats: [], polls: [], winnerTeamId: 1, tickets: [0, 0], endedAt: 0 }

		const pipeline = initPipeline(dbCtx, serverId, () => world.currentLayer)
		PendingEvents.onRconConnected(pipeline.state, clock, null, layerIdOf(world.currentLayer))
		await PendingEvents.process(pipeline.state, clock)

		for (let m = 0; m < opts.matchesPerServer; m++) {
			current = { lines: [], chats: [], polls: [], winnerTeamId: 1, tickets: [0, 0], endedAt: 0 }
			if (m === 0) {
				driver.fill()
			} else {
				world.replaceNextLayerUnlogged(ROTATION[m % ROTATION.length])
				world.startNewGame()
			}
			ended = false
			let nextPoll = clock
			while (!ended) {
				clock += TICK_MS
				driver.step()
				if (clock >= nextPoll) {
					// the poll is what places players a roll left team-less, as ListPlayers does on a real server
					world.handleCommand('ListPlayers')
					current.polls.push({ time: clock, teams: teamsOf(world) })
					nextPoll = clock + POLL_INTERVAL_MS
				}
			}
			current.winnerTeamId = winner
			current.tickets = [...world.tickets]
			current.endedAt = clock
			// the parser emits a tick only once the next one starts, so the round's end needs a line after it
			clock += TICK_MS
			world.logUnparsed(END_OF_MATCH_LINE)
			events += await replay(pipeline.state, current)
			const matchId = pipeline.currentMatchId()
			if (matchId !== null) {
				DB.run(
					dbCtx,
					Q.finalizeMatch({
						id: matchId,
						endTime: new Date(current.endedAt),
						outcome: current.winnerTeamId === 1 ? 'team1' : 'team2',
						team1Tickets: current.tickets[0],
						team2Tickets: current.tickets[1],
					}),
				)
			}
			clock += POST_MATCH_MS
			if ((m + 1) % 10 === 0) opts.log(`${serverId}: ${m + 1}/${opts.matchesPerServer} matches, ${events} events so far`)
		}
	}
	return { events }
}

function initPipeline(dbCtx: Parameters<typeof EventWrites.insertEvent>[0], serverId: string, layer: () => Fmt.LayerLike) {
	let currentMatchId: number | null = null
	const addMatch = (layerId: L.LayerId, time: number) => {
		const last = DB.get(dbCtx, Q.lastOrdinal({ serverId }))
		const entry = MH.getNewMatchHistoryEntry({ layerId, serverId, startTime: new Date(time) })
		// built per call: an insert definition would need a parameter for every column, and this runs once a match
		const [row] = DB.all(
			dbCtx,
			SQL.insert(Schema.matchHistory)
				.values({ ...entry, ...MH.layerParts(layerId), ordinal: last ? last.ordinal + 1 : 0, createdAt: new Date(time) })
				.returning(),
		)
		currentMatchId = row.id
		return MH.matchHistoryEntryToMatchDetails(row, true)
	}
	const state = PendingEvents.init({
		currentMatch: 'PENDING',
		counters: { squadId: Gen.counter() },
		log: quietLog,
		minSafeLogLeadTimeForOtherEvents: 1_500,
		hooks: {
			onNewGameDuringSync: (layerId, time) => Promise.resolve({ match: addMatch(layerId, time), isNewMatch: true }),
			onNewGameDuringRoll: (layerId, time) => Promise.resolve({ match: addMatch(layerId, time), nextLayerId: null }),
			fetchLayersStatus: () => {
				const id = layerIdOf(layer())
				return Promise.resolve({ currentLayer: { id, Layer: layer().layer }, nextLayer: null } as never)
			},
			fetchUsernamesNoTag: () => Promise.resolve(new Map()),
			skipDestroyedOnTrainingLayers: () => false,
			createEvent: (event) => Promise.resolve(EventWrites.insertEvent(dbCtx, serverId, event)),
		},
	})
	return { state, currentMatchId: () => currentMatchId }
}

// log events, chat and polls merged in time order, with one processing pass per slice as the live ingest runs
async function replay(state: PendingEvents.State, played: Played) {
	const errors: Error[] = []
	const parsed: SM.LogEvents.ParsedEvent[] = []
	async function* chunks() {
		yield played.lines.join('\n') + '\n'
	}
	for await (const ev of SM.LogEvents.parseLogStream(chunks(), errors)) {
		if (ev && ev.type !== 'UNKNOWN') parsed.push(ev as SM.LogEvents.ParsedEvent)
	}
	let chat = 0
	let poll = 0
	let emitted = 0
	for (let i = 0; i < parsed.length;) {
		let end = i + 1
		while (end < parsed.length && end - i < SLICE && parsed[end].time - parsed[i].time < DELIVERY_MS) end++
		const slice = parsed.slice(i, end)
		i = end
		const until = slice.at(-1)!.time
		while (poll < played.polls.length && played.polls[poll].time <= until) {
			const p = played.polls[poll++]
			PendingEvents.onTeamsPolled(state, p.teams, p.time)
		}
		while (chat < played.chats.length && played.chats[chat].time <= until) PendingEvents.onRconEvent(state, played.chats[chat++])
		for (const ev of slice) PendingEvents.onLogEvent(state, ev)
		emitted += (await PendingEvents.process(state, until + DELIVERY_LAG_MS)).length
	}
	return emitted
}

function teamsOf(world: World): SM.Teams {
	return {
		players: world.playerList().map((p) => ({
			ids: { eos: p.eos, steam: p.steam, username: p.name.trim() },
			teamId: p.teamId as SM.TeamId | null,
			squadId: p.squadId,
			isLeader: p.isLeader,
			isAdmin: false,
			role: p.role,
		})),
		squads: world.squads.map((s) => ({
			squadId: s.squadId,
			squadName: s.name,
			locked: s.locked,
			creator: s.creator.eos,
			teamId: s.teamId as SM.TeamId,
		})),
	}
}

function layerIdOf(layer: Fmt.LayerLike): L.LayerId {
	const [t1, t2] = layer.factions.split(/\s+/)
	return L.parseRawLayerText(`${layer.layer} ${t1} ${t2}`)?.id ?? (`RAW:${layer.layer}` as L.LayerId)
}
