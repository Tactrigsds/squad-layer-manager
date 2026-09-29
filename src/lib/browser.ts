import * as React from 'react'

import * as Rx from './rxjs'

// ctrl+enter, or cmd+enter on a mac: the chord that submits a form from inside a textarea
export function isSubmitChord(e: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
	return e.key === 'Enter' && (e.ctrlKey || e.metaKey)
}

export function isBrowser(): boolean {
	return typeof window !== 'undefined' && typeof document !== 'undefined'
}

const significantMouseMove$ = Rx.fromEvent(document, 'mousemove').pipe(
	Rx.throttleTime(300, Rx.asyncScheduler, { leading: true, trailing: false }),
	Rx.scan((blocks: boolean[], _) => {
		// Keep a sliding window of 5 blocks
		const newBlocks = [true, ...blocks.slice(0, 4)]
		return newBlocks
	}, [] as boolean[]),
	Rx.map((blocks) => {
		// Count how many blocks have movement (true values)
		const activeBlocks = blocks.filter(Boolean).length
		// Emit true when we have 3 or more active blocks out of our window
		return activeBlocks >= 3
	}),
	Rx.distinctUntilChanged(),
	Rx.share(),
)

// Deliberate user interaction: a click, key press, scroll, or touch. Passive mouse movement is
// excluded on purpose -- moving the cursor is enough to keep an active session alive (see
// userIsActive$) but should never be what starts one.
export const userInteracted$ = (function createInteractionObservable(): Rx.Observable<true> {
	return Rx.merge(
		// pointerdown, not just click: engagement is what establishes presence, and presence is the state
		// an action like "start editing" builds on. A document-level click listener runs *after* React's
		// onClick, so a first click that starts an activity would dispatch it before the presence it
		// depends on exists, and be dropped -- the user had to click twice.
		Rx.fromEvent(document, 'pointerdown'),
		Rx.fromEvent(document, 'click'),
		Rx.fromEvent(document, 'contextmenu'),
		Rx.fromEvent(document, 'keydown'),
		Rx.fromEvent(document, 'scroll'),
		Rx.fromEvent(document, 'touchstart'),
	).pipe(
		Rx.throttleTime(300, Rx.asyncScheduler, { leading: true, trailing: true }),
		Rx.map((): true => true),
		Rx.share(),
	)
})()

// Any sign of life, including sustained mouse movement. Broader than userInteracted$ -- use this to
// keep an already-active session from timing out, not to decide whether the user is engaged.
export const userIsActive$ = (function createPageActivityObservable(): Rx.Observable<true> {
	return Rx.merge(significantMouseMove$, userInteracted$).pipe(
		Rx.map((): true => true),
		Rx.share(),
	)
})()

// Read through useSyncExternalStore rather than seeding state and re-syncing in an effect: the first render already
// matches the viewport. A `useState(false)` seed paints the mobile layout for one frame on every desktop load, then
// snaps -- visible, and it churns any layout keyed off the result (the navbar's dashboard tab switcher mounts then
// unmounts).
function useMediaQuery(query: string) {
	const subscribe = React.useCallback(
		(onChange: () => void) => {
			const mediaQuery = window.matchMedia(query)
			mediaQuery.addEventListener('change', onChange)
			return () => mediaQuery.removeEventListener('change', onChange)
		},
		[query],
	)
	const getSnapshot = React.useCallback(() => window.matchMedia(query).matches, [query])
	return React.useSyncExternalStore(subscribe, getSnapshot, () => false)
}

// two-column dashboard tier: 660 for the layers side and 400 for Server Activity fit from here up
export function useIsDesktopSize() {
	return useMediaQuery('(min-width: 1100px)')
}

// the breakdown's legend rides in its title bar from here up; below it the title bar is too short and the legend
// moves into the chart
export function useIsWideDesktop() {
	return useMediaQuery('(min-width: 1200px)')
}

// true below the `phone` breakpoint (640px): the phone layout, whatever the pointer
export function useIsSmallViewport() {
	return useMediaQuery('(max-width: 639.98px)')
}

// the nav bar keeps some page links inline from here up; below it they all fold into one menu
export function useIsMediumViewport() {
	return useMediaQuery('(min-width: 900px)')
}

// three-column dashboard tier
export const ULTRAWIDE_QUERY = '(min-width: 2100px)'
export function useIsUltrawide() {
	return useMediaQuery(ULTRAWIDE_QUERY)
}

// emits on every change of the query's result, not the current value
export function mediaQueryChanged$(query: string): Rx.Observable<boolean> {
	return new Rx.Observable((subscriber) => {
		const mediaQuery = window.matchMedia(query)
		const onChange = (e: MediaQueryListEvent) => subscriber.next(e.matches)
		mediaQuery.addEventListener('change', onChange)
		return () => mediaQuery.removeEventListener('change', onChange)
	})
}

// a coarse pointer: touch density for button groups, sheets instead of floating windows. Keyed off the pointer,
// not the viewport, so tablets get it too
export function useCoarsePointer() {
	return useMediaQuery('(pointer: coarse)')
}
