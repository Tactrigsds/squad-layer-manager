/**
 * Contexts with no domain knowledge, so src/lib can depend on them. context-shared.models.ts re-exports all of them
 * for the rest of the app.
 */
import { type Link, trace } from '@opentelemetry/api'
import type pino from 'pino'

import * as CD from './ctx-def'
import * as Prom from './promise-utils'

export { CtxSymbol, init, isCtx } from './ctx-def'
export type Ctx = CD.Ctx

export type AbortSignal = { signal: globalThis.AbortSignal }
export const AbortSignalDef = CD.defCtx<Ctx & AbortSignal>()(['signal'], { name: 'abortSignal' })

export function addSignal<C extends Ctx & Partial<AbortSignal>>(ctx: C, signal: globalThis.AbortSignal): C & AbortSignal {
	return { ...ctx, signal: ctx.signal ? Prom.anySignal(signal, ctx.signal)! : signal }
}

export type Logger = pino.Logger

export type Log = Ctx & {
	log: Logger
}
export const LogDef = CD.defCtx<Log>()(['log'], { name: 'log' })

export namespace SpanLink {
	export const SOURCE = 'slm.link-source'
	export const SOURCE_TYPES = [
		// the span which invoked the event(or rx emission) that we're currently handling
		'event.emitter',
	] as const
	export type SourceType = (typeof SOURCE_TYPES)[number]
}

// carries links to spans that produced this ctx, flushed onto the next span the instrumentation opens.
export type Otel = Ctx & {
	otel: {
		links: Link[]
	}
}
export const OtelDef = CD.defCtx<Otel>()(['otel'], { name: 'otel' })

/**
 * Stamp a ctx with a LINK to the currently active span, overwriting any stored link.
 *
 * A link, deliberately, not a parent: the consumer opens its own root trace and points back at the
 * cause. Restoring the emitter's context instead would make every downstream handler a child of
 * whatever request triggered it, so one request's trace would grow without bound.
 */
export function linkToActiveSpan(type: SpanLink.SourceType): Link | undefined {
	const activeSpan = trace.getActiveSpan()
	if (!activeSpan) return
	return { context: activeSpan.spanContext(), attributes: { [SpanLink.SOURCE]: type } }
}

/**
 * Drop any inherited span links. For work whose cause is a timer rather than an upstream span, and
 * which outlives that span: a long-lived ctx keeps its links, so every op reusing it would link back
 * to something that ended long ago.
 */
export function withoutOtelLinks<T extends Ctx>(ctx: T): T & Otel {
	return { ...ctx, otel: { links: [] } }
}

export function storeLinkToActiveSpan<T extends Ctx>(ctx: T, type: SpanLink.SourceType): T & Otel {
	const link = linkToActiveSpan(type)
	return { ...ctx, otel: { links: link ? [link] : [] } }
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
			if (res.status === 'rejected' && !Prom.isAbortError(res.reason)) errors.push(res.reason)
		}
	}
	return errors
}
