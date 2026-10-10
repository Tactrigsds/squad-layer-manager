import '@/vitest-setup'

import * as Crypto from 'node:crypto'
import * as fs from 'node:fs'

import * as Gen from '@/lib/generator-utils'
import type * as CS from '@/models/context-shared.models'
import type * as L from '@/models/layer.models'
import type * as MH from '@/models/match-history.models'
import * as PendingEvents from '@/models/pending-events.models'
import type * as SE from '@/models/server-events.models'
import * as SM from '@/models/squad.models'

// Replays a SquadGame.log through PendingEvents the way squad-server's log ingest does: parsed events in slices of
// 50 with one processing pass per slice, and a teams poll echoing the live roster every 5s of log time. Prints
// throughput and a digest of the emitted events, so two versions can be compared for both speed and output.
//
// usage: NODE_ENV=test pnpm run script src/scripts/bench-pending-events.ts <SquadGame.log> [runs]

const SLICE = 50
const POLL_INTERVAL_MS = 5_000
// how far behind the log the replay clock runs, as if each line arrived 100ms after it was written
const DELIVERY_LAG_MS = 100

async function* fileChunks(path: string): AsyncGenerator<string> {
	const stream = fs.createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 })
	for await (const chunk of stream) yield chunk as string
}

async function parse(path: string) {
	const events: SM.LogEvents.ParsedEvent[] = []
	const errors: Error[] = []
	for await (const ev of SM.LogEvents.parseLogStream(fileChunks(path), errors)) {
		if (ev) events.push(ev as SM.LogEvents.ParsedEvent)
	}
	return events
}

const noop = () => {}
const log: CS.Logger = {
	info: noop,
	warn: noop,
	error: noop,
	debug: noop,
	trace: noop,
	fatal: noop,
	child: () => log,
} as unknown as CS.Logger

function makeState(emitted: SE.Event[]) {
	const ids = Gen.counter()
	const matchIds = Gen.counter()
	let lastClassname = 'Gorodok_RAAS_v1'
	const match = (layerId: L.LayerId) =>
		({ historyEntryId: Gen.next(matchIds), layerId, status: 'in-progress', ordinal: 1, serverId: 'bench' }) as unknown as MH.MatchDetails
	const state = PendingEvents.init({
		currentMatch: 'PENDING',
		counters: { squadId: Gen.counter() },
		log,
		minSafeLogLeadTimeForOtherEvents: 1_500,
		hooks: {
			onNewGameDuringSync: (layerId) => Promise.resolve({ match: match(layerId), isNewMatch: true }),
			onNewGameDuringRoll: (layerId) => Promise.resolve({ match: match(layerId), nextLayerId: null }),
			fetchLayersStatus: () => Promise.resolve({ currentLayer: { id: `RAW:${lastClassname}`, Layer: lastClassname }, nextLayer: null }),
			fetchUsernamesNoTag: () => Promise.resolve(new Map()),
			skipDestroyedOnTrainingLayers: () => false,
			createEvent: (event) => {
				const e = { ...event, id: Gen.next(ids) } as SE.Event
				emitted.push(e)
				return Promise.resolve(e)
			},
		},
	})
	return {
		state,
		onLog(ev: SM.LogEvents.ParsedEvent) {
			if (ev.type === 'NEW_GAME' && ev.layerClassname && ev.layerClassname !== 'TransitionMap') lastClassname = ev.layerClassname
		},
	}
}

async function replay(events: SM.LogEvents.ParsedEvent[]) {
	const emitted: SE.Event[] = []
	const { state, onLog } = makeState(emitted)
	const t0 = events[0].time - 1_000
	PendingEvents.onRconConnected(state, t0, null, 'RAW:Gorodok_RAAS_v1' as L.LayerId)
	await PendingEvents.process(state, t0)
	PendingEvents.onTeamsPolled(state, { players: [], squads: [] }, t0 + 1)
	PendingEvents.onLogEvent(state, { ...events[0], time: t0 + 2 })
	await PendingEvents.process(state, t0 + 2)

	let nextPoll = events[0].time + POLL_INTERVAL_MS
	let replayedUntil = events[0].time
	const start = performance.now()
	for (let i = 0; i < events.length; i += SLICE) {
		const slice = events.slice(i, i + SLICE)
		const now = slice.at(-1)!.time + DELIVERY_LAG_MS
		// the poll echoes the roster as of the log replayed so far, so it is stamped with that log's time
		if (replayedUntil >= nextPoll) {
			const teams = state.currTeams ? SM.fromLiveTeams(state.currTeams) : { players: [], squads: [] }
			PendingEvents.onTeamsPolled(state, teams, replayedUntil)
			await PendingEvents.process(state, now)
			nextPoll = replayedUntil + POLL_INTERVAL_MS
		}
		replayedUntil = slice.at(-1)!.time
		for (const ev of slice) {
			onLog(ev)
			PendingEvents.onLogEvent(state, ev)
		}
		await PendingEvents.process(state, now)
	}
	const ms = performance.now() - start
	const digest = Crypto.createHash('sha256')
	for (const e of emitted) digest.update(JSON.stringify(e))
	return { ms, emitted: emitted.length, digest: digest.digest('hex').slice(0, 16) }
}

async function main() {
	const [path, runsArg] = process.argv.slice(2)
	if (!path) {
		console.error('usage: NODE_ENV=test pnpm run script src/scripts/bench-pending-events.ts <SquadGame.log> [runs]')
		process.exit(1)
	}
	const events = await parse(path)
	console.log(`parsed ${events.length} log events`)
	const runs = Number(runsArg ?? 5)
	for (let r = 0; r < runs; r++) {
		const { ms, emitted, digest } = await replay(events)
		console.log(
			`run ${r + 1}: ${ms.toFixed(0)}ms, ${((ms * 1000) / events.length).toFixed(2)}us/log event, ${emitted} emitted, digest ${digest}`,
		)
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
