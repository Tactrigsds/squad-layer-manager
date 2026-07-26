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
 * to do it and every consumer gets the same treatment regardless of who is emitting.
 *
 * The link rides the value rather than the ambient context, for two independent reasons:
 *
 * - IsolatedSubject runs subscribers in the root async context, which resets otel's
 *   AsyncLocalStorage along with the mutex one it exists to isolate.
 * - durableSub defaults to sequential scheduling (concatMap), so a task queued behind another runs
 *   long after the emitting scope closed. Ambient restoration fails exactly when the system is busy.
 *
 * It is a link and never a parent. Trace shape is the consumer's decision -- durableSub opens a root
 * span and points back at the cause. Making handlers children instead would let one request's trace
 * absorb every downstream handler it triggered, without bound.
 */
export class TracedSubject<T, Base extends CS.Ctx = CS.Ctx> extends IsolatedSubject<[Base & CS.Otel, T]> {
	constructor(private readonly base: Base) {
		super()
	}

	/** emit `value`, stamped with a link to whatever span is active right now */
	emit(value: T) {
		this.next([CS.storeLinkToActiveSpan(this.base, 'event.emitter'), value])
	}
}
