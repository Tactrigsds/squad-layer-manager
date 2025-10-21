import * as Rx from 'rxjs'

export function isBrowser(): boolean {
	return typeof window !== 'undefined' && typeof document !== 'undefined'
}

export const interaction$ = (function createPageActivityObservable(): Rx.Observable<true> {
	const userActions$ = Rx.merge(
		Rx.fromEvent(document, 'mousemove'),
		Rx.fromEvent(document, 'onclick'),
		Rx.fromEvent(document, 'oncontext'),
		Rx.fromEvent(document, 'focus'),
		Rx.fromEvent(document, 'keydown'),
		Rx.fromEvent(document, 'scroll'),
		Rx.fromEvent(document, 'touchstart'),
	)

	return userActions$.pipe(
		Rx.map((): true => true),
		// Rx.debounceTime(250),
		Rx.share(),
	)
})()
