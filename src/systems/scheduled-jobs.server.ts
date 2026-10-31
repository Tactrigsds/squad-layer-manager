// Runs the jobs plugins declare (see SJOB in scheduled-jobs.models) and records each run in scheduledJobRuns.
//
// One timer serves every job. Each wake works out what is due: the latest unrun occurrence of each recurring job, and
// the stored one-off runs whose time has come. A run is claimed in the database before it starts, so an occurrence
// runs once however the timer and restarts line up. A run that was going when SLM stopped counts as a failed attempt,
// and is retried while its catch-up window lasts.
//
// A run that cannot do its work yet is blocked rather than failed: the job returns SJOB.Blocked, or SLM finds the run's
// server is not loaded. A blocked run is not an attempt. It runs again once its unblock fires, which for a promise or
// a subscribable is a wait held in `waits`; a blocked row with no time and no wait in memory, as after a restart, is
// run again straight away and hands back a fresh unblock. Its catch-up window still bounds it.
//
// A run's row can be rescheduled, cancelled or closed while a run of it is starting, going or waiting, so every state
// change is conditional on the state it expects, and a change that matches nothing leaves the row to whoever changed
// it.
//
// The plugin host attaches a plugin's jobs while the plugin is active, along with the ctx each run gets. Nothing here
// holds a ctx between runs: a run asks for one when it starts.
import * as E from 'drizzle-orm'
import superjson from 'superjson'

import type * as SchemaModels from '$root/drizzle/schema.models'
import * as Schema from '$root/drizzle/schema.ts'
import { assertNever } from '@/lib/type-guards'
import { z } from '@/lib/zod'
import * as AppEvents from '@/models/app-events.models'
import * as CS from '@/models/context-shared.models'
import * as SJOB from '@/models/scheduled-jobs.models'
import type * as USR from '@/models/users.models'
import type * as C from '@/server/context'
import * as DB from '@/server/db'
import { initModule } from '@/server/logger'
import * as Sql from '@/server/sql'
import * as AppEventsSys from '@/systems/app-events.server'
import * as CleanupSys from '@/systems/cleanup.server'
import * as MatchHistory from '@/systems/match-history.server'
import * as SquadServerActions from '@/systems/squad-server-actions.server'

const module = initModule('scheduled-jobs')
const SQL = Sql.forModule(module)
let log!: CS.Logger

const T = Schema.scheduledJobRuns
type Row = SchemaModels.ScheduledJobRun

const SERVER_NOT_LOADED = 'its server is not loaded'

// -------- statements --------

type State = Row['state']
const OPEN_STATES: State[] = ['pending', 'retrying', 'blocked']
const stateIn = (states: State[]) =>
	E.sql`${T.state} in (${E.sql.join(
		states.map((s) => SQL.lit(s)),
		E.sql`, `,
	)})`

const lastRecurringP = SQL.params({ pluginId: T.pluginId })
// sqlite takes a bare column next to max() from the row holding the max, so finishedAt is that run's
const lastRecurringOfEach = SQL.def(
	'lastRecurringOfEach',
	lastRecurringP,
	(byPlugin: boolean) =>
		SQL.select({ pluginId: T.pluginId, serverId: T.serverId, jobId: T.jobId, dueAt: E.max(T.dueAt), finishedAt: T.finishedAt })
			.from(T)
			.where(E.and(E.eq(T.kind, SQL.lit('recurring')), byPlugin ? E.eq(T.pluginId, lastRecurringP.pluginId) : undefined))
			.groupBy(T.pluginId, T.serverId, T.jobId),
	{ domains: [[true, false]] },
)

const openRuns = SQL.def('openRuns', SQL.params({}), SQL.select().from(T).where(stateIn(OPEN_STATES)))

const deletePendingP = SQL.params({ id: T.id, dueAt: T.dueAt })
const deletePendingRun = SQL.def(
	'deletePendingRun',
	deletePendingP,
	SQL.delete(T).where(E.and(E.eq(T.id, deletePendingP.id), E.eq(T.state, SQL.lit('pending')), E.eq(T.dueAt, deletePendingP.dueAt))),
)

const idInStateP = SQL.params({ id: T.id, state: T.state })
const blockOnServerNotLoaded = SQL.def(
	'blockOnServerNotLoaded',
	idInStateP,
	SQL.update(T)
		.set({ state: SQL.lit('blocked'), blockedReason: SQL.lit(SERVER_NOT_LOADED), nextAttemptAt: SQL.lit(null) })
		.where(E.and(E.eq(T.id, idInStateP.id), E.eq(T.state, idInStateP.state))),
)

const claimRecurringP = SQL.params({ pluginId: T.pluginId, serverId: T.serverId, jobId: T.jobId, key: T.key, dueAt: T.dueAt })
const insertRecurringRun = SQL.def(
	'insertRecurringRun',
	claimRecurringP,
	SQL.insert(T)
		.values({
			pluginId: claimRecurringP.pluginId,
			serverId: claimRecurringP.serverId,
			jobId: claimRecurringP.jobId,
			key: claimRecurringP.key,
			kind: SQL.lit('recurring'),
			dueAt: claimRecurringP.dueAt,
			state: SQL.lit('pending'),
		})
		.onConflictDoNothing()
		.returning(),
)

const supersedeP = SQL.params({
	pluginId: T.pluginId,
	serverId: T.serverId,
	jobId: T.jobId,
	dueAt: T.dueAt,
	finishedAt: T.finishedAt,
	error: T.error,
})
const skipEarlierOccurrences = SQL.def(
	'skipEarlierOccurrences',
	supersedeP,
	SQL.update(T)
		.set({ state: SQL.lit('skipped'), finishedAt: supersedeP.finishedAt, nextAttemptAt: SQL.lit(null), error: supersedeP.error })
		.where(
			E.and(
				E.eq(T.pluginId, supersedeP.pluginId),
				E.eq(T.serverId, supersedeP.serverId),
				E.eq(T.jobId, supersedeP.jobId),
				E.eq(T.kind, SQL.lit('recurring')),
				stateIn(OPEN_STATES),
				E.lt(T.dueAt, supersedeP.dueAt),
			),
		)
		.returning({ id: T.id }),
)

const pruneP = SQL.params({ before: T.finishedAt })
const pruneFinishedRuns = SQL.def(
	'pruneFinishedRuns',
	pruneP,
	(() => {
		const latestFinished = SQL.select({ id: T.id, finishedAt: E.max(T.finishedAt) })
			.from(T)
			.where(E.isNotNull(T.finishedAt))
			.groupBy(T.pluginId, T.serverId, T.jobId)
			.as('latestFinished')
		const latestRecurring = SQL.select({ id: T.id, dueAt: E.max(T.dueAt) })
			.from(T)
			.where(E.eq(T.kind, SQL.lit('recurring')))
			.groupBy(T.pluginId, T.serverId, T.jobId)
			.as('latestRecurring')
		return SQL.delete(T).where(
			E.and(
				stateIn(['succeeded', 'failed', 'skipped', 'cancelled']),
				E.lt(T.finishedAt, pruneP.before),
				E.notInArray(T.id, SQL.select({ id: latestFinished.id }).from(latestFinished)),
				E.notInArray(T.id, SQL.select({ id: latestRecurring.id }).from(latestRecurring)),
			),
		)
	})(),
	{ scans: ['scheduledJobRuns', 'latestFinished', 'latestRecurring'] },
)

const claimRunP = SQL.params({
	id: T.id,
	expectedState: T.state,
	dueAt: T.dueAt,
	payload: T.payload,
	attempt: T.attempt,
	startedAt: T.startedAt,
	manual: T.manual,
})
const claimRun = SQL.def(
	'claimRun',
	claimRunP,
	(hasPayload: boolean) =>
		SQL.update(T)
			.set({
				state: SQL.lit('running'),
				attempt: claimRunP.attempt,
				startedAt: claimRunP.startedAt,
				manual: claimRunP.manual,
				blockedReason: SQL.lit(null),
				cancelRequested: SQL.lit(false),
			})
			.where(
				E.and(
					E.eq(T.id, claimRunP.id),
					E.eq(T.state, claimRunP.expectedState),
					E.eq(T.dueAt, claimRunP.dueAt),
					hasPayload ? E.eq(T.payload, claimRunP.payload) : E.isNull(T.payload),
				),
			),
	{ domains: [[true, false]] },
)

const isRunning = (id: Sql.Parameter<number>) => E.and(E.eq(T.id, id), E.eq(T.state, SQL.lit('running')))

const finishRunP = SQL.params({ id: T.id, finishedAt: T.finishedAt })
const cancelRunning = SQL.def(
	'cancelRunning',
	finishRunP,
	SQL.update(T)
		.set({ state: SQL.lit('cancelled'), finishedAt: finishRunP.finishedAt, nextAttemptAt: SQL.lit(null), error: SQL.lit(null) })
		.where(isRunning(finishRunP.id)),
)
const succeedRunning = SQL.def(
	'succeedRunning',
	finishRunP,
	SQL.update(T)
		.set({ state: SQL.lit('succeeded'), finishedAt: finishRunP.finishedAt, error: SQL.lit(null), nextAttemptAt: SQL.lit(null) })
		.where(isRunning(finishRunP.id)),
)

const retryP = SQL.params({ id: T.id, nextAttemptAt: T.nextAttemptAt, error: T.error })
const retryRunning = SQL.def(
	'retryRunning',
	retryP,
	SQL.update(T)
		.set({ state: SQL.lit('retrying'), nextAttemptAt: retryP.nextAttemptAt, error: retryP.error })
		.where(isRunning(retryP.id)),
)

const failP = SQL.params({ id: T.id, finishedAt: T.finishedAt, error: T.error })
const failRun = SQL.def(
	'failRun',
	failP,
	SQL.update(T)
		.set({ state: SQL.lit('failed'), finishedAt: failP.finishedAt, error: failP.error, nextAttemptAt: SQL.lit(null) })
		.where(E.and(E.eq(T.id, failP.id), stateIn([...OPEN_STATES, 'running']))),
)

const skipP = SQL.params({ id: T.id, attempt: T.attempt, finishedAt: T.finishedAt, error: T.error })
const skipRunning = SQL.def(
	'skipRunning',
	skipP,
	SQL.update(T)
		.set({ state: SQL.lit('skipped'), attempt: skipP.attempt, finishedAt: skipP.finishedAt, error: skipP.error })
		.where(isRunning(skipP.id)),
)

const restoreP = SQL.params({
	id: T.id,
	state: T.state,
	attempt: T.attempt,
	startedAt: T.startedAt,
	manual: T.manual,
	nextAttemptAt: T.nextAttemptAt,
	blockedReason: T.blockedReason,
})
const restoreRunning = SQL.def(
	'restoreRunning',
	restoreP,
	SQL.update(T)
		.set({
			state: restoreP.state,
			attempt: restoreP.attempt,
			startedAt: restoreP.startedAt,
			manual: restoreP.manual,
			nextAttemptAt: restoreP.nextAttemptAt,
			blockedReason: restoreP.blockedReason,
		})
		.where(isRunning(restoreP.id)),
)

const blockP = SQL.params({ id: T.id, attempt: T.attempt, blockedReason: T.blockedReason, nextAttemptAt: T.nextAttemptAt })
const blockRunning = SQL.def(
	'blockRunning',
	blockP,
	SQL.update(T)
		.set({ state: SQL.lit('blocked'), attempt: blockP.attempt, blockedReason: blockP.blockedReason, nextAttemptAt: blockP.nextAttemptAt })
		.where(isRunning(blockP.id)),
)

const unblockP = SQL.params({ id: T.id, nextAttemptAt: T.nextAttemptAt })
const unblockRun = SQL.def(
	'unblockRun',
	unblockP,
	SQL.update(T)
		.set({ nextAttemptAt: unblockP.nextAttemptAt })
		.where(E.and(E.eq(T.id, unblockP.id), E.eq(T.state, SQL.lit('blocked')), E.isNull(T.nextAttemptAt))),
)

const onceP = SQL.params({ pluginId: T.pluginId, serverId: T.serverId, jobId: T.jobId, key: T.key, dueAt: T.dueAt, payload: T.payload })
const onceRow = {
	pluginId: onceP.pluginId,
	serverId: onceP.serverId,
	jobId: onceP.jobId,
	key: onceP.key,
	kind: SQL.lit('once'),
	dueAt: onceP.dueAt,
	payload: onceP.payload,
	state: SQL.lit('pending'),
	attempt: SQL.lit(0),
	nextAttemptAt: SQL.lit(null),
	manual: SQL.lit(false),
	startedAt: SQL.lit(null),
	finishedAt: SQL.lit(null),
	error: SQL.lit(null),
	blockedReason: SQL.lit(null),
	cancelRequested: SQL.lit(false),
}
const upsertOnceRun = SQL.def(
	'upsertOnceRun',
	onceP,
	SQL.insert(T)
		.values(onceRow)
		.onConflictDoUpdate({ target: [T.pluginId, T.serverId, T.jobId, T.key], set: onceRow, setWhere: E.ne(T.state, SQL.lit('running')) })
		.returning({ id: T.id }),
)

const runKeyP = SQL.params({ pluginId: T.pluginId, serverId: T.serverId, jobId: T.jobId, key: T.key })
const runKeyMatches = E.and(
	E.eq(T.pluginId, runKeyP.pluginId),
	E.eq(T.serverId, runKeyP.serverId),
	E.eq(T.jobId, runKeyP.jobId),
	E.eq(T.key, runKeyP.key),
)
const runByKey = SQL.def('runByKey', runKeyP, SQL.select().from(T).where(runKeyMatches))
const openOnceRunByKey = SQL.def(
	'openOnceRunByKey',
	runKeyP,
	SQL.select()
		.from(T)
		.where(E.and(runKeyMatches, E.eq(T.kind, SQL.lit('once')), stateIn(OPEN_STATES))),
)

const idP = SQL.params({ id: T.id })
const requestCancel = SQL.def(
	'requestCancel',
	idP,
	SQL.update(T)
		.set({ cancelRequested: SQL.lit(true) })
		.where(isRunning(idP.id)),
)

const isOpenInState = (id: Sql.Parameter<number>, state: Sql.Parameter<Row['state']>) =>
	E.and(E.eq(T.id, id), E.eq(T.state, state), stateIn(OPEN_STATES))
const deleteOpenRun = SQL.def('deleteOpenRun', idInStateP, SQL.delete(T).where(isOpenInState(idInStateP.id, idInStateP.state)))
const cancelOpenP = SQL.params({ id: T.id, state: T.state, finishedAt: T.finishedAt })
const cancelOpenRun = SQL.def(
	'cancelOpenRun',
	cancelOpenP,
	SQL.update(T)
		.set({ state: SQL.lit('cancelled'), finishedAt: cancelOpenP.finishedAt, nextAttemptAt: SQL.lit(null) })
		.where(isOpenInState(cancelOpenP.id, cancelOpenP.state)),
)

const manualRunP = SQL.params({ pluginId: T.pluginId, serverId: T.serverId, jobId: T.jobId, key: T.key, dueAt: T.dueAt })
const insertManualRun = SQL.def(
	'insertManualRun',
	manualRunP,
	SQL.insert(T)
		.values({
			pluginId: manualRunP.pluginId,
			serverId: manualRunP.serverId,
			jobId: manualRunP.jobId,
			key: manualRunP.key,
			kind: SQL.lit('manual'),
			dueAt: manualRunP.dueAt,
			state: SQL.lit('pending'),
		})
		.returning(),
)

const pluginP = SQL.params({ pluginId: T.pluginId })
// sqlite takes the bare columns next to max() from the row holding the max, so each row is that target's latest
const latestFinishedOfPlugin = SQL.def(
	'latestFinishedOfPlugin',
	pluginP,
	SQL.select({ ...E.getTableColumns(T), latestFinishedAt: E.max(T.finishedAt) })
		.from(T)
		.where(E.and(E.eq(T.pluginId, pluginP.pluginId), E.isNotNull(T.finishedAt)))
		.groupBy(T.serverId, T.jobId),
)
const openRunsOfPlugin = SQL.def(
	'openRunsOfPlugin',
	pluginP,
	SQL.select()
		.from(T)
		.where(E.and(E.eq(T.pluginId, pluginP.pluginId), stateIn([...OPEN_STATES, 'running'])))
		.orderBy(E.asc(T.dueAt)),
)
const deletePluginRuns = SQL.def('deletePluginRuns', pluginP, SQL.delete(T).where(E.eq(T.pluginId, pluginP.pluginId)))

const stoppedAtP = SQL.params({ at: T.finishedAt })
const closeCancellingRuns = SQL.def(
	'closeCancellingRuns',
	stoppedAtP,
	SQL.update(T)
		.set({
			state: SQL.lit('cancelled'),
			finishedAt: stoppedAtP.at,
			nextAttemptAt: SQL.lit(null),
			error: SQL.lit('SLM stopped while it was being cancelled'),
		})
		.where(E.and(E.eq(T.state, SQL.lit('running')), E.eq(T.cancelRequested, SQL.lit(true)))),
)
const retryAtP = SQL.params({ at: T.nextAttemptAt })
const retryInterruptedRuns = SQL.def(
	'retryInterruptedRuns',
	retryAtP,
	SQL.update(T)
		.set({ state: SQL.lit('retrying'), nextAttemptAt: retryAtP.at, error: SQL.lit('SLM stopped while it was running') })
		.where(E.eq(T.state, SQL.lit('running'))),
)

// finished runs older than this are deleted, except the latest of each job and target, which the settings page shows
// and a recurring job's next occurrence is worked out from
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60_000
const PRUNE_EVERY_MS = 60 * 60_000
// how long Run now waits for the run to say it is blocked, so the admin hears why
const RUN_NOW_WAIT_MS = 2000

export type RunCtx = C.Db & CS.AbortSignal & { log: CS.Logger } & Partial<C.ManagedServer>

// a job as the plugin declared it; its ctx and payload types are the plugin's business
type AnyJob = SJOB.Job<any, any, any>

export type Host = {
	pluginId: string
	log: CS.Logger
	jobs: ReadonlyMap<string, AnyJob>
	// the decoded config, or null while it does not parse
	config: () => unknown
	// a loaded server's ctx, or the plugin's for null; null while that server is not loaded
	ctxFor: (serverId: string | null) => RunCtx | null
	serverIds: () => string[]
}

const hosts = new Map<string, Host>()
// runs starting or going, by job and target, so a job never overlaps itself. A key is taken before the first await
// that leads to a run, and given back when the run ends or does not start.
const inFlight = new Set<string>()
// the signals blocked runs wait on, by run id
const waits = new Map<number, { pluginId: string; stop: () => void }>()
// runs being started or going, by run id
const running = new Map<number, Running>()
let timer: ReturnType<typeof setTimeout> | null = null
let ticking = false
let tickAgain = false
let stopped = false
let prunedAt = 0

const flightKey = (pluginId: string, serverId: string, jobId: string) => `${pluginId}|${serverId}|${jobId}`
const toServerId = (serverId: string | null) => serverId ?? ''
const fromServerId = (serverId: string) => (serverId === '' ? null : serverId)

function db() {
	return DB.withDb({ ...CS.init(), signal: CleanupSys.shutdownSignal })
}

function safeDurationMs(d: SJOB.Duration): number {
	try {
		return SJOB.durationMs(d)
	} catch {
		return Number.NaN
	}
}

function formatDuration(d: SJOB.Duration): string {
	return typeof d === 'string' ? d : `${d} ms`
}

function managedServerCtx(runCtx: RunCtx | null): (RunCtx & C.ManagedServer) | null {
	return runCtx?.server ? (runCtx as RunCtx & C.ManagedServer) : null
}

// -------- attaching --------

// the reasons a plugin's job list cannot be attached; empty when it can
export function jobListErrors(jobs: readonly AnyJob[]): string[] {
	const errors: string[] = []
	const seen = new Set<string>()
	for (const job of jobs) {
		const id = SJOB.JobIdSchema.safeParse(job.id)
		if (!id.success) errors.push(`job "${job.id}": ${z.prettifyError(id.error)}`)
		if (seen.has(job.id)) errors.push(`job "${job.id}" is listed twice`)
		seen.add(job.id)
		if (job.when && job.payload) errors.push(`job "${job.id}" is recurring, so it cannot take a payload`)
		for (const [name, d] of [
			['catchUp', job.catchUp],
			['timeout', job.timeout],
		] as const) {
			if (d !== undefined && !(safeDurationMs(d) > 0)) errors.push(`job "${job.id}": ${name} must be a positive duration`)
		}
	}
	return errors
}

export function attach(host: Host) {
	hosts.set(host.pluginId, host)
	wake()
}

export function detach(pluginId: string) {
	hosts.delete(pluginId)
	stopWaits(pluginId)
	wake()
}

// the timetable changed: a config was saved, a server loaded, a run was scheduled or unblocked
export function wake() {
	if (stopped) return
	if (ticking) {
		tickAgain = true
		return
	}
	arm(0)
}

function arm(delay: number) {
	if (timer) clearTimeout(timer)
	timer = setTimeout(() => void runTick(), Math.max(0, Math.min(delay, SJOB.MAX_SLEEP_MS)))
}

async function runTick() {
	timer = null
	ticking = true
	let next = Date.now() + SJOB.MAX_SLEEP_MS
	try {
		next = await tick(Date.now())
	} catch (err) {
		log.error(err, 'scheduled job tick failed')
	} finally {
		ticking = false
	}
	if (stopped) return
	const again = tickAgain
	tickAgain = false
	arm(again ? 0 : next - Date.now())
}

// -------- what is due --------

function specFor(host: Host, job: AnyJob, serverId: string | null): SJOB.Spec | null {
	if (!job.when) return null
	const cfg = host.config()
	if (cfg === null) return null
	try {
		const spec = job.when(cfg, serverId)
		if (!spec) return null
		const error = SJOB.specError(spec)
		if (error) {
			host.log.warn('job %s has an unusable schedule: %s', job.id, error)
			return null
		}
		return spec
	} catch (err) {
		host.log.error(err, 'job %s: reading its schedule failed', job.id)
		return null
	}
}

function targetsOf(host: Host, job: AnyJob): (string | null)[] {
	return job.scope === 'server' ? host.serverIds() : [null]
}

type LastRecurring = { dueAt: number; finishedAt: number | null }

// the latest recurring run of each job and target: its due time, and when it finished
function lastRecurringRuns(ctx: C.Db, pluginId?: string): Map<string, LastRecurring> {
	const rows = DB.all(ctx, lastRecurringOfEach(pluginId !== undefined)({ pluginId }))
	return new Map(
		rows.map((r) => [
			flightKey(r.pluginId, r.serverId, r.jobId),
			{ dueAt: Number(r.dueAt), finishedAt: r.finishedAt?.getTime() ?? null },
		]),
	)
}

// Starts everything due at `now`, and resolves to when the next thing comes due.
async function tick(now: number): Promise<number> {
	const ctx = db()
	let next = now + SJOB.MAX_SLEEP_MS
	if (now - prunedAt >= PRUNE_EVERY_MS) {
		prunedAt = now
		prune(ctx, now)
	}
	const last = lastRecurringRuns(ctx)

	for (const host of hosts.values()) {
		for (const job of host.jobs.values()) {
			if (!job.when) continue
			for (const serverId of targetsOf(host, job)) {
				const spec = specFor(host, job, serverId)
				if (!spec) continue
				const key = flightKey(host.pluginId, toServerId(serverId), job.id)
				const prev = last.get(key) ?? null
				const due = SJOB.dueOccurrence(spec, now, SJOB.catchUpMs(job), prev)
				const runCtx = due === null ? null : host.ctxFor(serverId)
				if (due !== null && runCtx && !inFlight.has(key)) {
					inFlight.add(key)
					let started = false
					try {
						const row = claimRecurring(ctx, host.pluginId, serverId, job.id, due)
						if (row) {
							supersede(ctx, row, now)
							void startRun(host, job, row, null, runCtx)
							started = true
						}
					} finally {
						if (!started) inFlight.delete(key)
					}
				}
				const upcoming = SJOB.nextOccurrence(spec, now, prev)
				if (upcoming !== null) next = Math.min(next, upcoming)
			}
		}
	}

	const open = DB.all(ctx, openRuns({}))
	for (const row of open) {
		const host = hosts.get(row.pluginId)
		const job = host?.jobs.get(row.jobId)
		if (!host || !job) continue
		const key = flightKey(row.pluginId, row.serverId, row.jobId)
		if (inFlight.has(key)) continue
		if (row.kind === 'manual') {
			// a Run now that SLM stopped during, which is not run again without an admin
			await fail(host, row, row.attempt, null, row.error ?? 'it did not finish')
			continue
		}
		const dueAt = row.dueAt.getTime()
		const windowEnd = dueAt + SJOB.catchUpMs(job)
		if (now > windowEnd) {
			if (row.state === 'pending') {
				// came due while SLM was not running, and is now too late to run: dropped without a record
				stopWait(row.id)
				DB.run(ctx, deletePendingRun({ id: row.id, dueAt: row.dueAt }))
			} else if (row.state === 'blocked') {
				await fail(host, row, row.attempt, null, `its catch-up window ended while it waited: ${row.blockedReason ?? 'blocked'}`)
			} else {
				await fail(host, row, row.attempt, null, row.error ?? 'its catch-up window ended before it succeeded')
			}
			continue
		}
		if (row.state === 'blocked' && row.nextAttemptAt === null && waits.has(row.id)) {
			next = Math.min(next, windowEnd + 1)
			continue
		}
		const at = row.nextAttemptAt?.getTime() ?? dueAt
		if (at > now) {
			next = Math.min(next, at, windowEnd + 1)
			continue
		}
		const runCtx = host.ctxFor(fromServerId(row.serverId))
		if (!runCtx) {
			// loading the server wakes the timer
			if (row.state !== 'blocked' || row.blockedReason !== SERVER_NOT_LOADED || row.nextAttemptAt !== null) {
				DB.run(ctx, blockOnServerNotLoaded({ id: row.id, state: row.state }))
			}
			next = Math.min(next, windowEnd + 1)
			continue
		}
		if (inFlight.has(key)) continue
		inFlight.add(key)
		void startRun(host, job, row, null, runCtx)
	}
	return next
}

function claimRecurring(ctx: C.Db, pluginId: string, serverId: string | null, jobId: string, dueAt: number): Row | null {
	const row = DB.get(
		ctx,
		insertRecurringRun({ pluginId, serverId: toServerId(serverId), jobId, key: SJOB.recurringKey(dueAt), dueAt: new Date(dueAt) }),
	)
	return row ?? null
}

// Closes the earlier occurrences of a recurring job that have not run, now that `row` replaces them: only the latest
// occurrence runs.
function supersede(ctx: C.Db, row: Row, now: number) {
	const closed = DB.all(
		ctx,
		skipEarlierOccurrences({
			pluginId: row.pluginId,
			serverId: row.serverId,
			jobId: row.jobId,
			dueAt: row.dueAt,
			finishedAt: new Date(now),
			error: `the occurrence due ${row.dueAt.toISOString()} replaced it`,
		}),
	)
	for (const { id } of closed) stopWait(id)
}

function prune(ctx: C.Db, now: number) {
	DB.run(ctx, pruneFinishedRuns({ before: new Date(now - PRUNE_AFTER_MS) }))
}

// -------- running --------

// the admin who started or cancelled a run
export type Manual = { userId: USR.UserId }

type Outcome =
	| { code: 'succeeded' }
	| { code: 'retrying' }
	| { code: 'failed'; error: string }
	| { code: 'blocked'; reason: string }
	| { code: 'cancelled' }
	// the row changed between being read and being claimed
	| { code: 'not-started' }

// A run being started or going, which cancel aborts through its controller. `cancelledBy` is set once it is cancelled:
// by an admin, or by the plugin for null.
type Running = { controller: AbortController; cancelledBy: { by: Manual | null } | null }

// whether the run stopped by throwing its signal's abort, rather than failing some other way while it was aborted
function isAbort(err: unknown, signal: AbortSignal): boolean {
	if (!signal.aborted) return false
	if (err === signal.reason) return true
	if (!(err instanceof Error)) return false
	return err.name === 'AbortError' || err.cause === signal.reason
}

// The caller has taken the job's flight key, which is given back when the run ends.
function startRun(host: Host, job: AnyJob, row: Row, manual: Manual | null, runCtx: RunCtx): Promise<Outcome> {
	const key = flightKey(row.pluginId, row.serverId, row.jobId)
	const outcome = execute(host, job, row, manual, runCtx).catch((err): Outcome => {
		host.log.error(err, 'job %s: recording its run failed', job.id)
		return { code: 'failed', error: 'recording its run failed' }
	})
	void outcome.finally(() => {
		inFlight.delete(key)
		wake()
	})
	return outcome
}

async function execute(host: Host, job: AnyJob, row: Row, manual: Manual | null, runCtx: RunCtx): Promise<Outcome> {
	// registered before the claim, so a cancel that finds the row running finds its controller
	const entry: Running = { controller: new AbortController(), cancelledBy: null }
	running.set(row.id, entry)
	try {
		return await executeClaimed(host, job, row, manual, runCtx, entry)
	} finally {
		running.delete(row.id)
	}
}

async function executeClaimed(host: Host, job: AnyJob, row: Row, manual: Manual | null, runCtx: RunCtx, entry: Running): Promise<Outcome> {
	const ctx = db()
	const attempt = row.attempt + 1
	const startedAt = Date.now()
	const claimed = DB.run(
		ctx,
		claimRun(row.payload !== null)({
			id: row.id,
			expectedState: row.state,
			dueAt: row.dueAt,
			payload: row.payload ?? undefined,
			attempt,
			startedAt: new Date(startedAt),
			manual: !!manual,
		}),
	)
	// rescheduled, cancelled or closed since it was read
	if (claimed.changes === 0) return { code: 'not-started' }
	stopWait(row.id)

	// the run's own signal, aborted by a cancel or the job's timeout, and by whatever aborts the ctx it was given
	const signal = AbortSignal.any([runCtx.signal, entry.controller.signal])
	const timeoutMs = job.timeout === undefined ? null : SJOB.durationMs(job.timeout)
	let timedOut = false
	const timeoutTimer =
		timeoutMs === null
			? undefined
			: setTimeout(() => {
					timedOut = true
					entry.controller.abort(new Error(`it ran longer than its timeout of ${formatDuration(job.timeout!)}`))
				}, timeoutMs)
	let abandonTimer: ReturnType<typeof setTimeout> | undefined
	const abandoned = new Promise<{ code: 'abandoned' }>((resolve) => {
		const startAbandonTimer = () => (abandonTimer = setTimeout(() => resolve({ code: 'abandoned' }), SJOB.ABANDON_AFTER_MS))
		if (signal.aborted) startAbandonTimer()
		else signal.addEventListener('abort', startAbandonTimer, { once: true })
	})

	const info: SJOB.RunInfo = {
		scheduledFor: row.dueAt.getTime(),
		key: row.key,
		manual: !!manual,
		attempt,
		signal,
	}
	let result: unknown = undefined
	let error: string | null = null
	let retryable = true
	let wasAbandoned = false
	let threwAbort = false
	try {
		const payload = decodePayload(job, row.payload)
		if (payload.code !== 'ok') {
			error = payload.message
			retryable = false
		} else {
			// spread, so the instance ctx other runs share keeps its own signal
			const run = job.run({ ...runCtx, signal }, info, payload.value).then((value: unknown) => ({ code: 'returned' as const, value }))
			const settled = await Promise.race([run, abandoned])
			if (settled.code === 'abandoned') wasAbandoned = true
			else result = settled.value
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err)
		threwAbort = isAbort(err, signal)
		if (!threwAbort) host.log.warn(err, 'job %s failed (attempt %d)', job.id, attempt)
	} finally {
		clearTimeout(timeoutTimer)
		clearTimeout(abandonTimer)
	}

	const now = Date.now()
	// cancelled only when the run stopped by throwing the abort; a run that finished some other way is recorded as it
	// finished
	if (entry.cancelledBy && threwAbort) {
		const res = DB.run(ctx, cancelRunning({ id: row.id, finishedAt: new Date(now) }))
		if (res.changes > 0) await record(runCtx, host, row, attempt, entry.cancelledBy.by, { code: 'cancelled' })
		return { code: 'cancelled' }
	}
	// an admin or the plugin asked it to stop, so it is not tried again
	if (entry.cancelledBy) retryable = false
	if (wasAbandoned) {
		host.log.warn('job %s did not stop within %ds of its signal aborting, so it was abandoned', job.id, SJOB.ABANDON_AFTER_MS / 1000)
		// it may still be going, so another attempt could overlap it
		retryable = false
		const after = SJOB.ABANDON_AFTER_MS / 1000
		error = entry.cancelledBy
			? `it did not stop within ${after}s of being cancelled`
			: timedOut
				? `it ran longer than its timeout of ${formatDuration(job.timeout!)}, and did not stop within ${after}s`
				: `it did not stop within ${after}s of its plugin or server stopping`
	} else if (timedOut && threwAbort) {
		error = `it ran longer than its timeout of ${formatDuration(job.timeout!)}`
	}
	if (error === null && result !== undefined) {
		const blocked = readBlocked(result)
		if (blocked.code === 'ok') return block(row, manual, runCtx, blocked.reason, blocked.unblock, now)
		error = blocked.message
		retryable = false
	}
	if (error === null) {
		const done = DB.run(ctx, succeedRunning({ id: row.id, finishedAt: new Date(now) }))
		if (done.changes > 0 && (manual || job.logSuccess)) await record(runCtx, host, row, attempt, manual, { code: 'succeeded' })
		return { code: 'succeeded' }
	}
	const retryAt = now + SJOB.retryDelayMs(attempt)
	if (!manual && retryable && retryAt <= row.dueAt.getTime() + SJOB.catchUpMs(job)) {
		DB.run(ctx, retryRunning({ id: row.id, nextAttemptAt: new Date(retryAt), error }))
		return { code: 'retrying' }
	}
	await fail(host, row, attempt, manual, error)
	return { code: 'failed', error }
}

// Closes a run that is open or running, and records the failure; a run something else closed first is left alone.
async function fail(host: Host, row: Row, attempt: number, manual: Manual | null, reason: string) {
	stopWait(row.id)
	const res = DB.run(db(), failRun({ id: row.id, finishedAt: new Date(), error: reason }))
	if (res.changes > 0) await record(host.ctxFor(fromServerId(row.serverId)), host, row, attempt, manual, { code: 'failed', error: reason })
}

function decodePayload(job: AnyJob, stored: string | null): { code: 'ok'; value: unknown } | { code: 'err'; message: string } {
	if (!job.payload) return { code: 'ok', value: undefined }
	const value = stored === null ? undefined : superjson.parse(stored)
	const parsed = job.payload.safeParse(value)
	if (!parsed.success) return { code: 'err', message: `its stored payload no longer fits the job: ${z.prettifyError(parsed.error)}` }
	return { code: 'ok', value: parsed.data }
}

type Recorded = { code: 'succeeded' } | { code: 'failed'; error: string } | { code: 'cancelled' }

// A server's run goes into that server's activity feed too, while the server is loaded; otherwise the event is only
// recorded in the audit log. `manual` is the admin who acted, or null for the plugin.
async function record(runCtx: RunCtx | null, host: Host, row: Row, attempt: number, manual: Manual | null, recorded: Recorded) {
	const serverCtx = managedServerCtx(runCtx)
	// the feed replays by matchId, so a server's event is filed under its current match
	const matchId = serverCtx ? ((await MatchHistory.getCurrentMatch(serverCtx))?.historyEntryId ?? null) : null
	const base = {
		actor: manual ? { type: 'slm-user' as const, userId: manual.userId } : { type: 'plugin' as const, pluginId: host.pluginId },
		serverId: fromServerId(row.serverId),
		matchId,
		causeId: null,
		pluginId: host.pluginId,
		jobId: row.jobId,
		key: row.key,
		scheduledFor: row.dueAt.getTime(),
		manual: !!manual,
		attempt,
	}
	let event: AppEvents.ScheduledJobSuccess | AppEvents.ScheduledJobFailed | AppEvents.ScheduledJobCancelled
	switch (recorded.code) {
		case 'succeeded':
			event = AppEvents.create<AppEvents.ScheduledJobSuccess>({ ...base, type: 'SCHEDULED_JOB_SUCCESS' })
			break
		case 'failed':
			event = AppEvents.create<AppEvents.ScheduledJobFailed>({ ...base, type: 'SCHEDULED_JOB_FAILED', error: recorded.error })
			break
		case 'cancelled':
			event = AppEvents.create<AppEvents.ScheduledJobCancelled>({ ...base, type: 'SCHEDULED_JOB_CANCELLED' })
			break
		default:
			assertNever(recorded)
	}
	if (serverCtx) await SquadServerActions.emitAppEvent(serverCtx, event)
	else AppEventsSys.persistAppEvent(db(), event)
}

// -------- blocking --------

type WaitSource = Exclude<SJOB.Unblock, SJOB.Duration>
type ReadUnblock = { kind: 'after'; ms: number } | { kind: 'signal'; source: WaitSource }

// what a run returned, read without trusting the plugin's types
function readBlocked(result: unknown): { code: 'ok'; reason: string; unblock: ReadUnblock } | { code: 'err'; message: string } {
	const blocked = result as Partial<SJOB.Blocked> | null
	if (typeof blocked !== 'object' || blocked === null || blocked.code !== 'blocked' || typeof blocked.reason !== 'string') {
		return { code: 'err', message: 'it returned something other than nothing or a blocked result' }
	}
	const unblock = readUnblock(blocked.unblock)
	if (!unblock) return { code: 'err', message: 'its unblock is not a duration, promise, async iterable or subscribable' }
	return { code: 'ok', reason: blocked.reason, unblock }
}

function readUnblock(unblock: unknown): ReadUnblock | null {
	if (typeof unblock === 'number' || typeof unblock === 'string') {
		let ms: number
		try {
			ms = SJOB.durationMs(unblock)
		} catch {
			return null
		}
		return Number.isFinite(ms) && ms >= 0 ? { kind: 'after', ms } : null
	}
	if (typeof unblock !== 'object' || unblock === null) return null
	const isSource =
		typeof (unblock as PromiseLike<unknown>).then === 'function' ||
		Symbol.asyncIterator in unblock ||
		typeof (unblock as SJOB.Subscribable<unknown>).subscribe === 'function'
	return isSource ? { kind: 'signal', source: unblock as WaitSource } : null
}

// Records a blocked run. A run an admin started is not left waiting: Run now on a recurring job closes its run, and on
// a scheduled run leaves that run as it was.
function block(row: Row, manual: Manual | null, runCtx: RunCtx, reason: string, unblock: ReadUnblock, now: number): Outcome {
	const ctx = db()
	if (row.kind === 'manual') {
		DB.run(ctx, skipRunning({ id: row.id, attempt: row.attempt, finishedAt: new Date(now), error: `blocked: ${reason}` }))
		return { code: 'blocked', reason }
	}
	if (manual) {
		DB.run(
			ctx,
			restoreRunning({
				id: row.id,
				state: row.state,
				attempt: row.attempt,
				startedAt: row.startedAt,
				manual: row.manual,
				nextAttemptAt: row.nextAttemptAt,
				blockedReason: row.blockedReason,
			}),
		)
		return { code: 'blocked', reason }
	}
	const rerunAt = unblock.kind === 'after' ? new Date(now + Math.max(unblock.ms, SJOB.MIN_BLOCKED_RERUN_MS)) : null
	const res = DB.run(ctx, blockRunning({ id: row.id, attempt: row.attempt, blockedReason: reason, nextAttemptAt: rerunAt }))
	if (res.changes > 0 && unblock.kind === 'signal') waitFor(row, unblock.source, runCtx.signal, now)
	return { code: 'blocked', reason }
}

// Waits on a blocked run's signal, and sets the run to go again when it fires. The wait ends without firing when the
// run's ctx is aborted, as when its plugin stops or its server is unloaded.
function waitFor(row: Row, source: WaitSource, signal: AbortSignal, blockedAt: number) {
	stopWait(row.id)
	let settled = false
	let stopSource = () => {}
	const settle = (fired: boolean) => {
		if (settled) return
		settled = true
		waits.delete(row.id)
		signal.removeEventListener('abort', onAbort)
		stopSource()
		if (fired) unblocked(row.id, blockedAt)
	}
	const onAbort = () => settle(false)
	waits.set(row.id, { pluginId: row.pluginId, stop: () => settle(false) })
	if (signal.aborted) return settle(false)
	signal.addEventListener('abort', onAbort, { once: true })
	stopSource = listen(source, () => settle(true))
	// the source fired while it was being subscribed to, before there was anything to stop
	if (settled) stopSource()
}

// Calls `fire` once the source settles, produces a value, errors or ends; returns a function that stops listening.
function listen(source: WaitSource, fire: () => void): () => void {
	try {
		if ('then' in source) {
			let live = true
			source.then(
				() => live && fire(),
				() => live && fire(),
			)
			return () => {
				live = false
			}
		}
		if (Symbol.asyncIterator in source) {
			const iterator = source[Symbol.asyncIterator]()
			let live = true
			iterator.next().then(
				() => live && fire(),
				() => live && fire(),
			)
			return () => {
				live = false
				void Promise.resolve(iterator.return?.()).catch(() => {})
			}
		}
		const sub = source.subscribe({ next: fire, error: fire, complete: fire })
		return () => sub.unsubscribe()
	} catch {
		fire()
		return () => {}
	}
}

function unblocked(rowId: number, blockedAt: number) {
	try {
		DB.run(db(), unblockRun({ id: rowId, nextAttemptAt: new Date(Math.max(Date.now(), blockedAt + SJOB.MIN_BLOCKED_RERUN_MS)) }))
	} catch (err) {
		log.error(err, 'recording that a blocked run can go again failed')
	}
	wake()
}

function stopWait(rowId: number) {
	waits.get(rowId)?.stop()
}

function stopWaits(pluginId: string) {
	for (const wait of [...waits.values()]) if (wait.pluginId === pluginId) wait.stop()
}

// -------- scheduling from plugins --------

export type ScheduleResult =
	| { code: 'ok'; key: string }
	| { code: 'err:unknown-job'; message: string }
	| { code: 'err:invalid-payload'; message: string }
	| { code: 'err:invalid-key'; message: string }
	| { code: 'err:busy'; message: string }

/**
 * Stores a one-off run of `jobId` at `at`. A pending or blocked run under the same key is replaced, and so is a
 * finished one, so scheduling "the reminder for this Friday" again moves it rather than adding a second. A running
 * one is not, and scheduling under its key returns err:busy.
 */
export function scheduleOnce(
	pluginId: string,
	serverId: string | null,
	jobId: string,
	at: number,
	payload: unknown,
	key: string | undefined,
): ScheduleResult {
	const job = hosts.get(pluginId)?.jobs.get(jobId)
	if (!job) return { code: 'err:unknown-job', message: `${pluginId} lists no job "${jobId}" in its jobs export` }
	if (job.when) return { code: 'err:unknown-job', message: `job "${jobId}" is recurring; its runs come from its schedule` }
	if ((job.scope === 'server') !== (serverId !== null)) {
		return { code: 'err:unknown-job', message: `job "${jobId}" is ${job.scope}-scoped; schedule it with a ${job.scope} ctx` }
	}
	const runKey = key ?? `once:${at}:${Math.random().toString(36).slice(2, 8)}`
	const keyCheck = SJOB.KeySchema.safeParse(runKey)
	if (!keyCheck.success) return { code: 'err:invalid-key', message: z.prettifyError(keyCheck.error) }
	let encoded: string | null = null
	if (job.payload) {
		const parsed = job.payload.safeParse(payload)
		if (!parsed.success) return { code: 'err:invalid-payload', message: z.prettifyError(parsed.error) }
		encoded = superjson.stringify(parsed.data)
		if (encoded.length > SJOB.MAX_PAYLOAD_BYTES) {
			return {
				code: 'err:invalid-payload',
				message: `the payload is ${encoded.length} bytes, over the ${SJOB.MAX_PAYLOAD_BYTES} allowed`,
			}
		}
	}
	const stored = DB.get(
		db(),
		upsertOnceRun({ pluginId, serverId: toServerId(serverId), jobId, key: runKey, dueAt: new Date(at), payload: encoded }),
	)
	if (!stored) return { code: 'err:busy', message: `the run under "${runKey}" is running; schedule it again once it has finished` }
	stopWait(stored.id)
	wake()
	return { code: 'ok', key: runKey }
}

export type CancelResult = { code: 'ok'; stopping: boolean } | { code: 'err:not-found' }

/**
 * Cancels the run under `key`, for `by` or else the plugin. A one-off run that has not started is removed, and a
 * recurring one is closed as cancelled. A running run has its signal aborted, and `stopping` is true: it is recorded
 * as cancelled once it stops by throwing that abort, and as whatever else it ended in otherwise.
 */
export function cancel(pluginId: string, serverId: string | null, jobId: string, key: string, by: Manual | null): CancelResult {
	const ctx = db()
	const row = DB.get(ctx, runByKey({ pluginId, serverId: toServerId(serverId), jobId, key }))
	if (!row) return { code: 'err:not-found' }
	if (row.state === 'running') {
		const entry = running.get(row.id)
		if (!entry) return { code: 'err:not-found' }
		if (!entry.cancelledBy) {
			entry.cancelledBy = { by }
			DB.run(ctx, requestCancel({ id: row.id }))
			entry.controller.abort(new DOMException('the run was cancelled', 'AbortError'))
		}
		return { code: 'ok', stopping: true }
	}
	const closed =
		row.kind === 'once'
			? DB.run(ctx, deleteOpenRun({ id: row.id, state: row.state }))
			: DB.run(ctx, cancelOpenRun({ id: row.id, state: row.state, finishedAt: new Date() }))
	if (closed.changes === 0) return { code: 'err:not-found' }
	stopWait(row.id)
	wake()
	return { code: 'ok', stopping: false }
}

// -------- run now, and what the settings page shows --------

/**
 * Runs a job now, for `userId`. With a key, it runs that one-off run, which is then done. Without one, it runs a
 * recurring job outside its schedule, leaving its next occurrence as it was. A run that says it is blocked within
 * RUN_NOW_WAIT_MS is reported back as err:blocked.
 */
export async function runNow(pluginId: string, serverId: string | null, jobId: string, key: string | null, userId: USR.UserId) {
	const host = hosts.get(pluginId)
	const job = host?.jobs.get(jobId)
	if (!host || !job) return { code: 'err:not-found' as const, message: 'the plugin is not running, or has no such job' }
	if (key === null && job.payload) {
		return { code: 'err:not-found' as const, message: 'a job that takes a payload can only run one of its scheduled runs' }
	}
	const runCtx = host.ctxFor(serverId)
	if (!runCtx) return { code: 'err:not-found' as const, message: 'that server is not loaded' }
	const flight = flightKey(pluginId, toServerId(serverId), jobId)
	if (inFlight.has(flight)) return { code: 'err:busy' as const, message: 'the job is already running there' }
	inFlight.add(flight)
	let outcome: Promise<Outcome> | null = null
	try {
		const ctx = db()
		let row: Row | undefined
		if (key !== null) {
			row = DB.get(ctx, openOnceRunByKey({ pluginId, serverId: toServerId(serverId), jobId, key }))
		} else {
			const now = Date.now()
			row = DB.get(
				ctx,
				insertManualRun({ pluginId, serverId: toServerId(serverId), jobId, key: SJOB.manualKey(now), dueAt: new Date(now) }),
			)
		}
		if (!row) return { code: 'err:not-found' as const, message: 'no such pending run' }
		outcome = startRun(host, job, row, { userId }, runCtx)
	} finally {
		if (!outcome) {
			inFlight.delete(flight)
			wake()
		}
	}
	let timeout: ReturnType<typeof setTimeout> | undefined
	const early = await Promise.race([outcome, new Promise<null>((resolve) => (timeout = setTimeout(() => resolve(null), RUN_NOW_WAIT_MS)))])
	clearTimeout(timeout)
	if (early?.code === 'blocked') return { code: 'err:blocked' as const, message: early.reason }
	return { code: 'ok' as const }
}

export function listJobs(pluginId: string): SJOB.JobView[] {
	const host = hosts.get(pluginId)
	if (!host) return []
	const ctx = db()
	const now = Date.now()
	const latestFinished = DB.all(ctx, latestFinishedOfPlugin({ pluginId }))
	const open = DB.all(ctx, openRunsOfPlugin({ pluginId }))
	const last = lastRecurringRuns(ctx, pluginId)
	return [...host.jobs.values()].map((job): SJOB.JobView => ({
		id: job.id,
		scope: job.scope,
		recurring: !!job.when,
		// where the job is scheduled, or has run: a server the plugin is switched off for is left out
		targets: targetsOf(host, job).flatMap((serverId) => {
			const spec = specFor(host, job, serverId)
			const latest = latestFinished.find((r) => r.jobId === job.id && r.serverId === toServerId(serverId))
			const ofTarget = open.filter((r) => r.kind !== 'once' && r.jobId === job.id && r.serverId === toServerId(serverId))
			if (!spec && !latest && ofTarget.length === 0) return []
			const blocked = ofTarget.find((r) => r.kind === 'recurring' && r.state === 'blocked')
			const going = ofTarget.find((r) => r.state === 'running')
			return [
				{
					serverId,
					nextRunAt: spec ? SJOB.nextOccurrence(spec, now, last.get(flightKey(pluginId, toServerId(serverId), job.id)) ?? null) : null,
					blockedReason: blocked?.blockedReason ?? null,
					running: going ? { key: going.key, cancelling: going.cancelRequested } : null,
					last: latest
						? { state: latest.state, manual: latest.manual, finishedAt: latest.finishedAt!.getTime(), error: latest.error }
						: null,
				},
			]
		}),
		pending: open
			.filter((r) => r.kind === 'once' && r.jobId === job.id)
			.map((r) => ({
				serverId: fromServerId(r.serverId),
				key: r.key,
				dueAt: r.dueAt.getTime(),
				state: r.state,
				attempt: r.attempt,
				nextAttemptAt: r.nextAttemptAt?.getTime() ?? null,
				blockedReason: r.blockedReason,
				cancelling: r.cancelRequested,
			})),
	}))
}

// a plugin's data is being deleted
export function purge(ctx: C.Db, pluginId: string) {
	stopWaits(pluginId)
	DB.run(ctx, deletePluginRuns({ pluginId }))
}

// -------- boot --------

export function setup() {
	log = module.getLogger()
	// A run going when SLM stopped is a failed attempt, retried from now while its window lasts; the tick sorts out
	// which windows have closed. One being cancelled is closed instead, without a SCHEDULED_JOB_CANCELLED: it never
	// threw its abort.
	const ctx = db()
	const now = new Date()
	DB.run(ctx, closeCancellingRuns({ at: now }))
	DB.run(ctx, retryInterruptedRuns({ at: now }))
	CleanupSys.register(() => {
		stopped = true
		if (timer) clearTimeout(timer)
		for (const wait of [...waits.values()]) wait.stop()
	})
	arm(0)
}
