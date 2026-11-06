// Jobs a plugin runs on a schedule, or once at a time it picks, with data of its own. A job is declared as data and
// listed in the plugin's server module (`jobs`); scheduled-jobs.server.ts runs it and records each run in
// scheduledJobRuns. This module holds the job's shape and the timing rules, which are pure.
import { Cron } from 'croner'

import * as TZ from '@/lib/time-zones'
import { assertNever } from '@/lib/type-guards'
import { z } from '@/lib/zod'
import * as ZodUtils from '@/lib/zod-utils'
import type * as MH from '@/models/match-history.models'

export type Scope = 'server' | 'plugin'

// milliseconds, or a duration such as '6h'
export type Duration = number | string

// When a recurring job runs: at the times a cron pattern names, read in an IANA timezone or in the job's server's own
// zone for 'server', every so long after its last run finished, or relative to the current match on the job's server.
export type Spec = { cron: string; timezone: string } | { every: Duration } | MatchSpec

// `after` the current match starts or ends, then again every `every` while the match is still in that phase: until
// it ends for 'start', and until the next one starts for 'end'. Only a server job can take one.
export type MatchSpec = { match: MatchAnchor; after: Duration; every?: Duration | null }
export type MatchAnchor = 'start' | 'end'

// what a MatchSpec is measured from: when the server's current match started, or when it ended
export type MatchTimes = { status: 'in-progress'; startTime: number } | { status: 'post-game'; endTime: number } | null

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
	// what admins see the job as, in place of its id
	label?: string
	// what the job does, shown to admins under its label
	description?: string
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
	label: string | null
	description: string | null
	scope: Scope
	recurring: boolean
	targets: {
		serverId: string | null
		// null while the job is not scheduled there
		nextRunAt: number | null
		// the match boundary a match-relative job waits for before its next run can be timed
		awaiting: MatchAnchor | null
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

export function afterMatchStart(after: Duration, opts?: { every?: Duration }): Spec {
	return { match: 'start', after, every: opts?.every ?? null }
}

export function afterMatchEnd(after: Duration): Spec {
	return { match: 'end', after }
}

export function isMatchSpec(spec: Spec): spec is MatchSpec {
	return 'match' in spec
}

export function matchTimes(match: MH.MatchDetails | undefined): MatchTimes {
	if (!match) return null
	if (match.status === 'in-progress') return match.startTime ? { status: 'in-progress', startTime: match.startTime.getTime() } : null
	return match.endTime instanceof Date ? { status: 'post-game', endTime: match.endTime.getTime() } : null
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
		if ('cron' in spec) {
			if (!TZ.isValid(spec.timezone)) return `"${spec.timezone}" is not a time zone`
			cronFor(spec)
		} else if (isMatchSpec(spec)) {
			if (!(durationMs(spec.after) >= 0)) return 'the delay after the match boundary must not be negative'
			if (spec.every != null && !(durationMs(spec.every) > 0)) return 'the interval must be positive'
		} else if (!(durationMs(spec.every) > 0)) return 'the interval must be positive'
		return null
	} catch (err) {
		return err instanceof Error ? err.message : String(err)
	}
}

// The first occurrence of a match-relative spec in the current match's phase, and the interval it repeats at.
function matchSeries(spec: MatchSpec, match: MatchTimes): { first: number; every: number | null } | null {
	const every = spec.every == null ? null : durationMs(spec.every)
	switch (spec.match) {
		case 'start':
			return match?.status === 'in-progress' ? { first: match.startTime + durationMs(spec.after), every } : null
		case 'end':
			return match?.status === 'post-game' ? { first: match.endTime + durationMs(spec.after), every } : null
		default:
			assertNever(spec.match)
	}
}

/**
 * The occurrence of a recurring job that should run now, or null. `last` is the job's most recent recurring run there,
 * and `match` the times of the current match on the job's server, which only a match-relative spec reads.
 *
 * For a cron or match-relative spec, it is the latest occurrence within the catch-up window that has not run, so a job
 * that was down for three weeks runs once, not three times, and one outside the window leaves no trace. For an
 * interval, it is due once the interval has passed since the last run finished, or straight away when there has never
 * been one.
 */
export function dueOccurrence(
	spec: Spec,
	now: number,
	catchUp: number,
	last: { dueAt: number; finishedAt: number | null } | null,
	match: MatchTimes = null,
): number | null {
	let latest: number | null
	if ('cron' in spec) {
		// croner works in whole seconds and looks strictly before the reference, so one second past now includes now
		latest =
			cronFor(spec)
				.previousRuns(1, new Date(now + 1000))[0]
				?.getTime() ?? null
	} else if (isMatchSpec(spec)) {
		const series = matchSeries(spec, match)
		if (!series || series.first > now) return null
		latest = series.every === null ? series.first : series.first + Math.floor((now - series.first) / series.every) * series.every
	} else {
		if (!last) return now
		// a run still going has no finish to anchor to, and is not overlapped
		if (last.finishedAt === null) return null
		const at = last.finishedAt + durationMs(spec.every)
		return at <= now ? at : null
	}
	if (latest === null || latest > now || latest <= now - catchUp) return null
	if (last && latest <= last.dueAt) return null
	return latest
}

// when a recurring job next comes due after `now`, for the settings page and the timer. A match-relative job has
// none while the current match is not in the phase it waits for.
export function nextOccurrence(
	spec: Spec,
	now: number,
	last: { dueAt: number; finishedAt: number | null } | null,
	match: MatchTimes = null,
): number | null {
	if ('cron' in spec) return cronFor(spec).nextRun(new Date(now))?.getTime() ?? null
	if (isMatchSpec(spec)) {
		const series = matchSeries(spec, match)
		if (!series) return null
		if (series.first > now) return series.first
		if (series.every === null) return null
		return series.first + (Math.floor((now - series.first) / series.every) + 1) * series.every
	}
	if (!last) return now
	if (last.finishedAt === null) return null
	return last.finishedAt + durationMs(spec.every)
}

// the match boundary a match-relative spec is waiting for, or null when it is timed or is not match-relative
export function awaitedBoundary(spec: Spec, match: MatchTimes): MatchAnchor | null {
	if (!isMatchSpec(spec)) return null
	return matchSeries(spec, match) ? null : spec.match
}
