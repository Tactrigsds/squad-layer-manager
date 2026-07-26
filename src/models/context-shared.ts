import type * as OtelApi from '@opentelemetry/api'
import type pino from 'pino'

import * as CD from '@/lib/ctx-def'
import * as Prom from '@/lib/promise-utils'

export { CtxSymbol, init, isCtx } from '@/lib/ctx-def'
export type Ctx = CD.Ctx

// every per-server context composes with this, so it lives in the leaf: a domain models file taking
// it from server-state would close a runtime cycle, since server-state imports several of them for
// their schemas.
export type ServerId = Ctx & {
	serverId: string
}
export const ServerIdDef = CD.defCtx<ServerId>()(['serverId'], { name: 'serverId' })

export type AbortSignal = { signal: globalThis.AbortSignal }
export const AbortSignalDef = CD.defCtx<Ctx & AbortSignal>()(['signal'], { name: 'abortSignal' })

// carries links to spans that produced this ctx, flushed onto the next span the instrumentation opens.
// A primitive rather than server-side because the rcon and match-history payloads type streams with it.
export type Otel = Ctx & {
	otel: {
		links: OtelApi.Link[]
	}
}
export const OtelDef = CD.defCtx<Otel>()(['otel'], { name: 'otel' })

export type Logger = pino.Logger

export type Log = Ctx & {
	log: Logger
}
export const LogDef = CD.defCtx<Log>()(['log'], { name: 'log' })

export function addSignal<C extends Ctx & Partial<AbortSignal>>(ctx: C, signal: globalThis.AbortSignal): C & AbortSignal {
	return { ...ctx, signal: ctx.signal ? Prom.anySignal(signal, ctx.signal)! : signal }
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
