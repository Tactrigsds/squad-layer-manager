import { AsyncResource } from 'async_hooks'
import * as Rx from 'rxjs'

// used in nodejs as a means to make sure subscribers don't pollute the async context of subject callers. important for use with reentrant mutexes (./nodejs-reentrant-mutexes.ts)

// Capture the root context (before any als.run())
const rootContext = AsyncResource.bind((fn) => fn())

export class IsolatedSubject<T> extends Rx.Subject<T> {
	next(value: T) {
		rootContext(() => super.next(value))
	}
}
