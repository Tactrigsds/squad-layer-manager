import type * as SJOB from '@/models/scheduled-jobs.models'
import type * as PluginsSys from '@/systems/plugins.server'
import * as SchedJobs from '@/systems/scheduled-jobs.server'

/**
 * Jobs that run on a schedule, or once at a time the plugin picks, with data of their own. SLM runs each job, retries
 * a failed run within its catch-up window, and keeps scheduled runs across restarts.
 *
 * A job is declared with `job` and listed in the server module's `jobs` export, beside `migrations`:
 *
 *     export const remind = Schedule.job({ id: 'remind', scope: 'server', payload: z.object({ rotationId: z.string() }),
 *       catchUp: '12h', run: async (sctx, run, payload) => { ... } })
 *     export const jobs = [remind]
 *
 * A job with `when` is recurring: `when(config, serverId)` returns its schedule, and is read again whenever the
 * plugin's config is saved. `weekly` and `daily` turn settings fields into a schedule. Any other job runs only when
 * scheduled with `at`, which stores the run and its payload until it comes due.
 *
 * A run that throws is tried again, backing off, until `catchUp` after its time. A run missed while SLM was down is
 * caught up within that window too, and only the latest one of a recurring job; beyond it, it is dropped. A run that
 * finally fails is recorded as SCHEDULED_JOB_FAILED. A successful run is recorded as SCHEDULED_JOB_SUCCESS when an
 * admin ran it by hand, or always with `logSuccess`. Admins see every job and its pending runs under the plugin in
 * settings, where they can run or cancel one.
 *
 * A run that cannot do its work yet returns `blocked(reason, unblock)`, and is run again once `unblock` fires: after a
 * duration, or when a promise settles or an observable emits. A blocked run is not a failed attempt. Admins see the
 * reason while it waits, and it fails with the reason if `catchUp` runs out first. SLM blocks a server's run itself
 * while that server is not loaded. Check what the run needs before changing anything, so a blocked run leaves nothing
 * half done.
 *
 * A run's signal, on both `run.signal` and its ctx, aborts when the run is cancelled, when it outlasts the job's
 * `timeout`, and when its plugin or server stops. Pass the signal on and throw its abort: a cancelled run is recorded as
 * SCHEDULED_JOB_CANCELLED only when it stops by throwing that abort, and is recorded as whatever else it ended in
 * otherwise. A timed-out run that throws the abort fails and is retried. A run still going 10 seconds after its signal
 * aborted is abandoned: it fails, and its job can run again.
 *
 * A run can be attempted again after an interruption or a block, so make it safe to repeat: `run.scheduledFor` and
 * `run.key` identify the occurrence.
 */

export { daily, weekly } from '@/models/scheduled-jobs.models'
export type { Blocked, Duration, RunInfo, RunResult, Spec, Subscribable, Unblock } from '@/models/scheduled-jobs.models'

/**
 * The result of a run that cannot do its work yet. `unblock` is a duration, a promise, an async iterable or an
 * observable. The run goes again once it fires, and no sooner than a second after it was blocked, so emit only when it
 * is worth trying again: `connected$.pipe(filter(Boolean))`, not `connected$`.
 */
export function blocked(reason: string, unblock: SJOB.Unblock): SJOB.Blocked {
	return { code: 'blocked', reason, unblock }
}

export type ServerJob<P = undefined, Cfg = any> = SJOB.Job<PluginsSys.ServerCtx<any>, P, Cfg> & { scope: 'server' }
export type PluginJob<P = undefined, Cfg = any> = SJOB.Job<PluginsSys.Ctx<any>, P, Cfg> & { scope: 'plugin' }
export type Job<P = undefined, Cfg = any> = ServerJob<P, Cfg> | PluginJob<P, Cfg>

/** Returns the definition as given. It exists so the payload's type is inferred from its schema. */
export function job<P = undefined, Cfg = any>(def: ServerJob<P, Cfg>): ServerJob<P, Cfg>
export function job<P = undefined, Cfg = any>(def: PluginJob<P, Cfg>): PluginJob<P, Cfg>
export function job(def: Job<unknown>) {
	return def
}

/**
 * When the run is due, its payload, and optionally a key: scheduling again under a key replaces that run, unless it is
 * running, which returns err:busy.
 */
export type At<P> = { at: number | Date; key?: string } & (undefined extends P ? { payload?: P } : { payload: P })

export type ScheduleResult = SchedJobs.ScheduleResult

/**
 * Schedules one run of `job`. A server job takes the server ctx of the server it runs on, and a plugin job the plugin
 * ctx. The job must be listed in `jobs`, and the payload must fit its schema.
 */
export async function at<P>(ctx: PluginsSys.ServerCtx<any>, job: ServerJob<P>, run: At<P>): Promise<ScheduleResult>
export async function at<P>(ctx: PluginsSys.Ctx<any>, job: PluginJob<P>, run: At<P>): Promise<ScheduleResult>
export async function at(ctx: PluginsSys.Ctx<any>, job: Job<unknown>, run: At<unknown>): Promise<ScheduleResult> {
	const when = typeof run.at === 'number' ? run.at : run.at.getTime()
	return SchedJobs.scheduleOnce(ctx.plugin.id, serverIdOf(ctx, job), job.id, when, run.payload, run.key)
}

export type CancelResult = SchedJobs.CancelResult

/**
 * Cancels the run of `job` under `key`. A run that has not started is removed. A running run has its signal aborted,
 * and `stopping` is true: it is recorded as SCHEDULED_JOB_CANCELLED once it stops by throwing that abort.
 */
export async function cancel(ctx: PluginsSys.Ctx<any>, job: Job<any>, key: string): Promise<CancelResult> {
	return SchedJobs.cancel(ctx.plugin.id, serverIdOf(ctx, job), job.id, key, null)
}

function serverIdOf(ctx: PluginsSys.Ctx<any>, job: Job<any>): string | null {
	return job.scope === 'server' ? ((ctx as Partial<PluginsSys.ServerCtx<any>>).serverId ?? null) : null
}
