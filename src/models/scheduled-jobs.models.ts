// Jobs a plugin runs on a schedule, or once at a time it picks, with data of its own. A job is declared as data and
// listed in the plugin's server module (`jobs`); scheduled-jobs.server.ts runs it and records each run in
// scheduledJobRuns. This module holds the job's shape and the timing rules, which are pure.
import { Cron } from 'croner'

import { z } from '@/lib/zod'
import * as ZodUtils from '@/lib/zod-utils'

export type Scope = 'server' | 'plugin'

// milliseconds, or a duration such as '6h'
export type Duration = number | string

// When a recurring job runs: at the times a cron pattern names, read in an IANA timezone, or every so long after its
// last run finished.
export type Spec = { cron: string; timezone: string } | { every: Duration }

export type RunInfo = {
	// the time the run was due, which identifies the occurrence: a stable key for idempotent work
	scheduledFor: number
	key: string
	manual: boolean
	attempt: number
	signal: AbortSignal
}

// a source of values that can be subscribed to, such as an rxjs Observable, named structurally so rxjs stays out of
// the plugin API
export type Subscribable<T> = {
	subscribe(observer: { next?: (value: T) => void; error?: (err: unknown) => void; complete?: () => void }): {
		unsubscribe(): void
	}
}

// When a blocked run is tried again: after a duration, or when a promise settles, or an async iterable or subscribable
// produces a value, errors or ends.
export type Unblock = Duration | PromiseLike<unknown> | AsyncIterable<unknown> | Subscribable<unknown>

// The run could not do its work yet. It is not an attempt: it is run again once `unblock` fires, until the job's
// catch-up window ends, and `reason` is shown to admins while it waits.
export type Blocked = { code: 'blocked'; reason: string; unblock: Unblock }

export type RunResult = void | Blocked

export type Job<Ctx = any, P = undefined, Cfg = any> = {
	id: string
	scope: Scope
	// the shape of the data a one-off run carries. A recurring job takes none.
	payload?: z.ZodType<P>
	// makes the job recurring. Re-read whenever the plugin's config is saved; null leaves it unscheduled there.
	when?: (cfg: Cfg, serverId: string | null) => Spec | null
	// how long after its time a run is still attempted, which also bounds retries and catch-up after downtime
	catchUp?: Duration
	// how long a run may take before its signal is aborted and it counts as a failed attempt
	timeout?: Duration
	// records an event for every successful automatic run, not only for manual ones
	logSuccess?: boolean
	run: (ctx: Ctx, run: RunInfo, payload: P) => Promise<RunResult>
}

export const JobIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9_-]+$/, { error: 'Must contain only lowercase letters, numbers, hyphens, and underscores' })

export const KeySchema = z.string().min(1).max(128)

// skipped: a recurring occurrence a later one replaced before it could run
export type RunState = 'pending' | 'running' | 'retrying' | 'blocked' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
export type RunKind = 'once' | 'recurring' | 'manual'

// what the settings page shows of one job
export type JobView = {
	id: string
	scope: Scope
	recurring: boolean
	targets: {
		serverId: string | null
		// null while the job is not scheduled there
		nextRunAt: number | null
		// what the current occurrence is waiting for, while it is blocked
		blockedReason: string | null
		// the run going there now, of the recurring job or a Run now of it
		running: { key: string; cancelling: boolean } | null
		last: { state: RunState; manual: boolean; finishedAt: number | null; error: string | null } | null
	}[]
	pending: {
		serverId: string | null
		key: string
		dueAt: number
		state: RunState
		attempt: number
		nextAttemptAt: number | null
		blockedReason: string | null
		// cancelled while running, and not yet stopped
		cancelling: boolean
	}[]
}

// the timer is woken at least this often, so a clock change cannot strand a run
export const MAX_SLEEP_MS = 60_000
const DEFAULT_CATCH_UP_MS = 5 * 60_000
const RETRY_BASE_MS = 60_000
const RETRY_CAP_MS = 10 * 60_000
// payloads point at data rather than carry it
export const MAX_PAYLOAD_BYTES = 16 * 1024
// a blocked run is not run again sooner than this, so an unblock that fires at once cannot spin it
export const MIN_BLOCKED_RERUN_MS = 1000
// A run whose signal was aborted, by a cancel or its timeout, that has not returned this long after is abandoned: it is
// closed and its job may run again, since a run that ignores its signal could otherwise hold its job forever.
export const ABANDON_AFTER_MS = 10_000

export function durationMs(d: Duration): number {
	return ZodUtils.parseHumanTime(d)
}

export function catchUpMs(job: Pick<Job, 'catchUp'>): number {
	return job.catchUp === undefined ? DEFAULT_CATCH_UP_MS : durationMs(job.catchUp)
}

// the delay before attempt n+1, after attempt n failed: doubling from a minute, capped at ten
export function retryDelayMs(attempt: number): number {
	return Math.min(RETRY_BASE_MS * 2 ** Math.max(attempt - 1, 0), RETRY_CAP_MS)
}

export function recurringKey(dueAt: number): string {
	return `@${dueAt}`
}

export function manualKey(now: number): string {
	return `manual:${now}`
}

// "HH:MM", 24-hour
const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/

function timeParts(time: string): { hour: number; minute: number } {
	const match = TIME_OF_DAY.exec(time)
	if (!match) throw new Error(`"${time}" is not a 24-hour HH:MM time`)
	return { hour: Number(match[1]), minute: Number(match[2]) }
}

// every `weekday` (0 is Sunday) at `time`, in `timezone`: the spec a pair of structured settings fields turns into
export function weekly(weekday: number, time: string, timezone: string): Spec {
	const { hour, minute } = timeParts(time)
	return { cron: `${minute} ${hour} * * ${weekday}`, timezone }
}

export function daily(time: string, timezone: string): Spec {
	const { hour, minute } = timeParts(time)
	return { cron: `${minute} ${hour} * * *`, timezone }
}

const crons = new Map<string, Cron>()
function cronFor(spec: { cron: string; timezone: string }): Cron {
	const k = `${spec.timezone}|${spec.cron}`
	let c = crons.get(k)
	if (!c) {
		c = new Cron(spec.cron, { timezone: spec.timezone, paused: true })
		crons.set(k, c)
	}
	return c
}

// the reason a spec cannot be used, or null
export function specError(spec: Spec): string | null {
	try {
		if ('cron' in spec) cronFor(spec)
		else if (!(durationMs(spec.every) > 0)) return 'the interval must be positive'
		return null
	} catch (err) {
		return err instanceof Error ? err.message : String(err)
	}
}

/**
 * The occurrence of a recurring job that should run now, or null. `last` is the job's most recent recurring run there.
 *
 * For a cron spec, it is the latest occurrence within the catch-up window that has not run, so a job that was down
 * for three weeks runs once, not three times, and one outside the window leaves no trace. For an interval, it is due
 * once the interval has passed since the last run finished, or straight away when there has never been one.
 */
export function dueOccurrence(
	spec: Spec,
	now: number,
	catchUp: number,
	last: { dueAt: number; finishedAt: number | null } | null,
): number | null {
	if ('cron' in spec) {
		// croner works in whole seconds and looks strictly before the reference, so one second past now includes now
		const [latest] = cronFor(spec).previousRuns(1, new Date(now + 1000))
		if (!latest) return null
		const at = latest.getTime()
		if (at > now || at <= now - catchUp) return null
		if (last && at <= last.dueAt) return null
		return at
	}
	if (!last) return now
	// a run still going has no finish to anchor to, and is not overlapped
	if (last.finishedAt === null) return null
	const at = last.finishedAt + durationMs(spec.every)
	return at <= now ? at : null
}

// when a recurring job next comes due after `now`, for the settings page and the timer
export function nextOccurrence(spec: Spec, now: number, last: { dueAt: number; finishedAt: number | null } | null): number | null {
	if ('cron' in spec) return cronFor(spec).nextRun(new Date(now))?.getTime() ?? null
	if (!last) return now
	if (last.finishedAt === null) return null
	return last.finishedAt + durationMs(spec.every)
}
