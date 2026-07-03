import { AsyncResource } from 'async_hooks'
import * as Rx from 'rxjs'

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
		new Rx.Observable(subscriber => {
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
