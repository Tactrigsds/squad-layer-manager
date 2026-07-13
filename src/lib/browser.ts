import * as React from 'react'
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
	return Rx.merge(
		significantMouseMove$,
		userInteracted$,
	).pipe(
		Rx.map((): true => true),
		Rx.share(),
	)
})()

export function useIsDesktopSize() {
	const [isDesktop, setIsDesktop] = React.useState(false)

	React.useEffect(() => {
		const mediaQuery = window.matchMedia('(min-width: 1280px)')
		setIsDesktop(mediaQuery.matches)

		const handleChange = (e: MediaQueryListEvent) => {
			setIsDesktop(e.matches)
		}

		mediaQuery.addEventListener('change', handleChange)
		return () => mediaQuery.removeEventListener('change', handleChange)
	}, [])
	return isDesktop
}

// true below the Tailwind `sm` breakpoint (640px) -- the width at which the navbar collapses its links into a hamburger
export function useIsSmallViewport() {
	const [isSmall, setIsSmall] = React.useState(false)

	React.useEffect(() => {
		const mediaQuery = window.matchMedia('(max-width: 639.98px)')
		setIsSmall(mediaQuery.matches)

		const handleChange = (e: MediaQueryListEvent) => {
			setIsSmall(e.matches)
		}

		mediaQuery.addEventListener('change', handleChange)
		return () => mediaQuery.removeEventListener('change', handleChange)
	}, [])
	return isSmall
}
