import * as E from 'drizzle-orm'
import * as Timers from 'node:timers/promises'
import { Worker } from 'node:worker_threads'

import * as Schema from '$root/drizzle/schema'
import * as Prom from '@/lib/promise-utils'
import type * as CS from '@/models/context-shared'
import * as MH from '@/models/match-history.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import * as Env from '@/server/env'
import { initModule } from '@/server/logger'
import * as CleanupSys from '@/systems/cleanup.server'
import { mh, pendingCombatStatsCond } from '@/systems/combat-stats.shared'
import type * as CombatStatsWorker from '@/systems/combat-stats.worker'

// The catch-up that gives every match a scoreline.
//
// Tallying one costs a full feed replay, so it happens once per match ever and the six columns on matchHistory
// hold the answer. The replay itself runs on a worker thread (combat-stats.worker.ts) because a server with
// years of history has tens of thousands of matches to get through and that loop is also the rcon and websocket
// loop. This side asks for a small batch at a time, writes what comes back, and waits: the pacing is here
// because it is the thread that would suffer, and the writes are here because the app keeps one writer.

const module = initModule('combat-stats')
let log!: CS.Logger

const envBuilder = Env.getEnvBuilder({ ...Env.groups.general, ...Env.groups.db })
let ENV!: ReturnType<typeof envBuilder>

// -------- the worker --------

let worker: Worker | undefined
let nextSeq = 1
let shuttingDown = false
const pending = new Map<number, { resolve: (res: CombatStatsWorker.EngineResponse) => void; reject: (err: unknown) => void }>()

function failPending(err: unknown) {
	for (const p of pending.values()) p.reject(err)
	pending.clear()
}

/**
 * The worker, started the first time there is actually a match to tally.
 *
 * Lazily, because most installs are caught up most of the time: the thread costs a db connection and a layer-data
 * decompress, and an app that would only ever have it sit idle should not pay for either. That also means a crash
 * needs no reboot schedule -- the next round asks again, and the pause between rounds is the retry interval.
 */
function ensureWorker(): Worker | undefined {
	if (worker || shuttingDown) return worker
	try {
		// under tsx this module's url is the .ts source and the worker needs the loader passed along; from the
		// prod bundle both are built .js chunks side by side in dist-server/
		const isTs = import.meta.url.endsWith('.ts')
		const url = new URL(isTs ? './combat-stats.worker.ts' : './combat-stats.worker.js', import.meta.url)
		const w = new Worker(url, { workerData: { dbPath: ENV.DB_PATH }, execArgv: isTs ? ['--import', 'tsx'] : undefined })
		w.on('message', (msg: CombatStatsWorker.Response) => {
			const p = pending.get(msg.seq)
			if (!p) return
			pending.delete(msg.seq)
			if (msg.err) p.reject(Object.assign(new Error(msg.err.message), { stack: msg.err.stack }))
			else p.resolve(msg.res!)
		})
		w.on('error', (err) => {
			log.error(err, 'combat stats worker failed')
			if (worker === w) worker = undefined
			failPending(err)
		})
		w.on('exit', () => {
			if (worker === w) worker = undefined
			failPending(new Error('combat stats worker exited'))
		})
		// the worker must never hold the process open
		w.unref()
		worker = w
	} catch (err) {
		log.error(err, 'combat stats worker failed to boot; scorelines are not being tallied')
	}
	return worker
}

export function setup() {
	log = module.getLogger()
	ENV = envBuilder()
	CleanupSys.register(async () => {
		shuttingDown = true
		await worker?.terminate()
	})
}

async function dispatch(ctx: CS.AbortSignal, req: CombatStatsWorker.EngineRequest): Promise<CombatStatsWorker.EngineResponse | null> {
	if (!ensureWorker()) return null
	const seq = nextSeq++
	// an aborted caller just stops waiting: the replay is synchronous and cannot be interrupted
	const onAbort = () => {
		const p = pending.get(seq)
		if (!p) return
		pending.delete(seq)
		p.reject(ctx.signal.reason)
	}
	try {
		return await new Promise((resolve, reject) => {
			pending.set(seq, { resolve, reject })
			ctx.signal.addEventListener('abort', onAbort)
			worker!.postMessage({ seq, req } satisfies CombatStatsWorker.Request)
		})
	} finally {
		ctx.signal.removeEventListener('abort', onAbort)
	}
}

// -------- the catch-up --------

// How many matches one round trip tallies. Small on purpose: the pause between rounds is what keeps a catch-up
// over years of history from pinning a core, and a short round is also what lets a match that just ended get
// its scoreline promptly.
const BATCH = 4
// Between rounds while there is still work, and after a round that found none. The idle wait is the only cost
// on an install that is already caught up, which is every install after its first pass.
const BUSY_PAUSE = 2_000
const IDLE_PAUSE = 30_000

// Matches whose tally threw. Excluded for the life of the process rather than forever: a transient read failure
// is retried on the next boot, but the loop can never get stuck on the same match.
const skipped = new Set<number>()

/**
 * Tally and store every match on this server that has no scoreline, newest first, until there are none left,
 * then keep watching for the ones new matches leave behind.
 *
 * Runs for the life of the managed server. Resumable by construction: the worklist is a db predicate, so a
 * restart mid-catch-up picks up exactly where it stopped.
 */
export async function runCatchUp(ctx: C.Db & MH.Ctx & CS.AbortSignal, opts: () => CombatStatsWorker.EngineRequest['opts']) {
	// A match becomes tallyable when a later one starts, which is one of the things that moves the window, so an
	// idle loop waits on the window rather than on the clock: the row a roll just left behind would otherwise sit
	// blank for the whole idle pause. Latched, because an update that lands mid-round has to survive until the
	// wait it is meant to skip -- hence cleared before the round rather than after.
	let woken = false
	let wake: (() => void) | undefined
	const sub = ctx.matchHistory.update$.subscribe(() => {
		woken = true
		wake?.()
	})
	try {
		for (;;) {
			ctx.signal.throwIfAborted()
			woken = false
			let tallied = 0
			try {
				// asked here rather than left to the worker so that an app with nothing to tally -- which is every
				// caught-up install, most of the time -- never starts the thread in the first place
				if (await hasPendingMatches(ctx)) {
					const res = await dispatch(ctx, { serverId: ctx.serverId, opts: opts(), limit: BATCH, skip: [...skipped] })
					for (const matchId of res?.failed ?? []) skipped.add(matchId)
					for (const { matchId, stats } of res?.tallies ?? []) {
						await storeCombatStats(ctx, matchId, stats)
						tallied++
					}
				}
			} catch (err) {
				if (Prom.isAbortError(err)) return
				// a round names no one match, so nothing can be skipped for it; a worker that is down reboots on
				// its own and the next round finds the same work waiting
				log.error(err, 'a combat stats round failed')
			}
			if (tallied === 0 && woken) continue
			// the loser of the race is left pending, so the timer swallows the rejection an abort gives it and
			// the loop's own abort check is what ends things
			const paused = Timers.setTimeout(tallied > 0 ? BUSY_PAUSE : IDLE_PAUSE, undefined, { signal: ctx.signal }).catch(() => {})
			await Promise.race([paused, new Promise<void>((resolve) => (wake = resolve))])
		}
	} catch (err) {
		if (!Prom.isAbortError(err)) throw err
	} finally {
		sub.unsubscribe()
	}
}

async function hasPendingMatches(ctx: C.Db & CS.ServerId & CS.AbortSignal): Promise<boolean> {
	const [row] = await ctx
		.db()
		.select({ id: mh.id })
		.from(mh)
		.where(pendingCombatStatsCond(ctx.serverId, [...skipped]))
		.limit(1)
	return row !== undefined
}

/**
 * A match's scoreline onto its row, and into the in-memory window if it is still in it.
 *
 * The window is patched rather than reloaded: a reload is what asked for this work in the first place, and the
 * catch-up spends most of its life on matches too old for anything in memory to reference.
 */
async function storeCombatStats(ctx: C.Db & MH.Ctx & CS.AbortSignal, matchId: number, stats: MH.MatchCombatStats) {
	await DB.runTransaction(ctx, async (ctx) => {
		await ctx.db().update(Schema.matchHistory).set(MH.combatStatsToColumns(stats)).where(E.eq(Schema.matchHistory.id, matchId))
	})
	const state = ctx.matchHistory
	if (!state.recentMatches.some((match) => match.historyEntryId === matchId)) return
	state.recentMatches = state.recentMatches.map((match) => (match.historyEntryId === matchId ? { ...match, combatStats: stats } : match))
	state.dispatchUpdate()
}
