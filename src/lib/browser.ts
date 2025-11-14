import * as Rx from 'rxjs'

export function isBrowser(): boolean {
	return typeof window !== 'undefined' && typeof document !== 'undefined'
}

const significantMouseMove$ = Rx.fromEvent(document, 'mousemove').pipe(
	Rx.throttleTime(300, Rx.asyncScheduler, { leading: true, trailing: false }),
	Rx.scan(
		(blocks: boolean[], _) => {
			// Keep a sliding window of 5 blocks
			const newBlocks = [true, ...blocks.slice(0, 4)]
			return newBlocks
		},
		[] as boolean[],
	),
	Rx.map((blocks) => {
		// Count how many blocks have movement (true values)
		const activeBlocks = blocks.filter(Boolean).length
		// Emit true when we have 3 or more active blocks out of our window
		return activeBlocks >= 3
	}),
	Rx.distinctUntilChanged(),
	Rx.share(),
)

export const userIsActive$ = (function createPageActivityObservable(): Rx.Observable<true> {
	const userActions$ = Rx.merge(
		significantMouseMove$,
		Rx.fromEvent(document, 'click'),
		Rx.fromEvent(document, 'contextmenu'),
		Rx.fromEvent(document, 'keydown'),
		Rx.fromEvent(document, 'scroll'),
		Rx.fromEvent(document, 'touchstart'),
	)

	return userActions$.pipe(
		Rx.observeOn(Rx.asyncScheduler),
		Rx.map((): true => true),
		Rx.share(),
	)
})()
