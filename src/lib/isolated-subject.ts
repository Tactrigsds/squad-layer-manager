import type * as OtelApi from '@opentelemetry/api'
import { AsyncResource } from 'async_hooks'

import * as CS from '@/models/context-shared'

import * as Rx from './rxjs'

// used in nodejs as a means to make sure subscribers don't pollute the async context of subject callers. important for use with reentrant mutexes (./nodejs-reentrant-mutexes.ts)

// Capture the root context (before any als.run())
const rootContext = AsyncResource.bind((fn) => fn())

export class IsolatedSubject<T> extends Rx.Subject<T> {
	next(value: T) {
		rootContext(() => super.next(value))
	}

	error(err: any): void {
		rootContext(() => super.error(err))
	}

	complete() {
		rootContext(() => super.complete())
	}
}

export class IsolatedBehaviorSubject<T> extends Rx.BehaviorSubject<T> {
	next(value: T) {
		rootContext(() => super.next(value))
	}

	error(err: any): void {
		rootContext(() => super.error(err))
	}

	complete() {
		rootContext(() => super.complete())
	}
}

export class IsolatedReplaySubject<T> extends Rx.ReplaySubject<T> {
	next(value: T) {
		rootContext(() => super.next(value))
	}

	error(err: any): void {
		rootContext(() => super.error(err))
	}

	complete() {
		rootContext(() => super.complete())
	}
}

export function isolateContext() {
	return <T>(source: Rx.Observable<T>) =>
		new Rx.Observable((subscriber) => {
			return source.subscribe({
				next: (v) => rootContext(() => subscriber.next(v)),
				error: (e) => rootContext(() => subscriber.error(e)),
				complete: () => rootContext(() => subscriber.complete()),
			})
		})
}

export function isolateCb<T>(cb: () => T) {
	return rootContext(() => cb()) as T
}

/**
 * Pairs every emission with a link back to the span that produced it, so no caller has to remember
 * to do it, and every consumer gets the same treatment regardless of who is emitting.
 *
 * The link rides the value rather than the ambient context, for two independent reasons:
 *
 * - IsolatedSubject runs subscribers in the root async context, which resets otel's
 *   AsyncLocalStorage along with the mutex one, so a subscriber sees no active span.
 * - durableSub defaults to sequential scheduling (concatMap), so a task queued behind another runs
 *   long after the emitting scope closed.
 *
 * It is a link and never a parent. Trace shape is the consumer's decision (durableSub opens a root
 * span); this only offers the causal edge. Restoring the emitter's context would instead make every
 * handler a child of whatever request triggered it, growing that trace without bound.
 *
 * Each subscriber gets its OWN ctx object, built in the per-subscriber map below. spanOp consumes
 * links destructively, so handing every subscriber one shared ctx would let whichever ran first
 * blank the link for the rest.
 */
export class TracedSubject<T, Base extends CS.Ctx = CS.Ctx> extends Rx.Observable<[Base & CS.Otel, T]> {
	private readonly inner = new IsolatedSubject<[OtelApi.Link | undefined, T]>()

	constructor(base: Base) {
		super((subscriber) =>
			this.inner
				.pipe(Rx.map(([link, value]): [Base & CS.Otel, T] => [{ ...base, otel: { links: link ? [link] : [] } }, value]))
				.subscribe(subscriber),
		)
	}

	/** emit `value`, stamped with a link to whatever span is active right now */
	emit(value: T) {
		this.inner.next([CS.linkToActiveSpan('event.emitter'), value])
	}

	complete() {
		this.inner.complete()
	}
}
