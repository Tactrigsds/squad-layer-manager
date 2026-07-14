import { anySignal, isAbortError } from '@/lib/async'
import type * as F from '@/models/filter.models'
import type * as LC from '@/models/layer-columns'
import type * as MH from '@/models/match-history.models'
import type pino from 'pino'
import type * as LE from './layer-engine'

const CtxSymbol = Symbol('context')
export type Ctx = {
	[CtxSymbol]: true
}
export function init(): Ctx {
	return {
		[CtxSymbol]: true,
	}
}
export function isCtx(ctx: any): ctx is Ctx {
	return ctx && ctx[CtxSymbol] === true
}

export type EffectiveColumnConfig = Ctx & { effectiveColsConfig: LC.EffectiveColumnConfig }

// the weighted-random layer generation config. unlike effectiveColsConfig this is admin-editable at runtime
// (globalSettings.layerGeneration), so holders must refresh it when settings change
export type LayerGeneration = Ctx & { generationConfig: LC.LayerGenerationConfig }

// the columnar query engine (layer-engine/), which replaced the SQLite layer db. It is immutable for its lifetime, so it
// is shared by every request rather than opened per query.
export type LayerEngine = Ctx & { engine: LE.EngineHandle } & EffectiveColumnConfig
export type AbortSignal = { signal: globalThis.AbortSignal }

export type Logger = pino.Logger

export type Log = Ctx & {
	log: Logger
}

export type Filters = Ctx & {
	filters: Map<string, F.FilterEntity>
}

export type MatchHistory = Ctx & {
	recentMatches: MH.MatchDetails[]
}
export type LayerQuery = Ctx & LayerEngine & Log & Filters & LayerGeneration

export function addSignal<C extends Ctx & Partial<AbortSignal>>(ctx: C, signal: globalThis.AbortSignal): C & AbortSignal {
	return { ...ctx, signal: ctx.signal ? anySignal(signal, ctx.signal)! : signal }
}

// A bucket of background promises a callee schedules for an ancestor to await (via awaitDeferred) before
// it finishes. This keeps best-effort side work (e.g. sending an admin warn) inside the ancestor's
// lifetime and signal, instead of leaking it as a fire-and-forget `void` promise that could reject
// unobserved and crash the process. The array is shared by reference through ctx spreads, mirroring the
// mutable releaseTasks/unlockTasks buckets on the server ctx.
export type Deferred = Ctx & {
	deferred: Promise<unknown>[]
}

export function initDeferred<C extends Ctx>(ctx: C): C & Deferred {
	return { ...ctx, deferred: [] }
}

export function defer(ctx: Deferred, ...promises: Promise<unknown>[]): void {
	ctx.deferred.push(...promises)
}

// Awaits and clears all deferred work, looping so deferred work can itself defer more. Uses allSettled
// (never Promise.all) so one rejection can't abandon its still-pending siblings as floating promises,
// which would resurrect the very unhandled-rejection risk deferral exists to prevent. Benign abort
// cancellations are dropped; any other rejection reasons are returned for the caller to log with its own
// logger (kept out of the primitive so this stays a leaf with no logger dependency). Best-effort by
// design: failures never propagate to perturb the awaiting task.
export async function awaitDeferred(ctx: Deferred): Promise<unknown[]> {
	const errors: unknown[] = []
	while (ctx.deferred.length > 0) {
		for (const res of await Promise.allSettled(ctx.deferred.splice(0))) {
			if (res.status === 'rejected' && !isAbortError(res.reason)) errors.push(res.reason)
		}
	}
	return errors
}
