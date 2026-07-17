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

function useMediaQuery(query: string) {
	// Lazy init off matchMedia so the first render already matches the viewport. A `useState(false)` seed
	// paints the mobile layout for one frame on every desktop load, then snaps -- visible, and it churns any
	// layout keyed off the result (the navbar's dashboard tab switcher mounts then unmounts).
	const [matches, setMatches] = React.useState(() => isBrowser() && window.matchMedia(query).matches)

	React.useEffect(() => {
		const mediaQuery = window.matchMedia(query)
		setMatches(mediaQuery.matches)
		const handleChange = (e: MediaQueryListEvent) => setMatches(e.matches)
		mediaQuery.addEventListener('change', handleChange)
		return () => mediaQuery.removeEventListener('change', handleChange)
	}, [query])
	return matches
}

export function useIsDesktopSize() {
	return useMediaQuery('(min-width: 1280px)')
}

// true below the Tailwind `sm` breakpoint (640px) -- the width at which the navbar collapses its links into a hamburger
export function useIsSmallViewport() {
	return useMediaQuery('(max-width: 639.98px)')
}

// The scrollable this wheel event is already going to move, if any: the first ancestor between the target and `root`
// that both scrolls and has somewhere left to go. `scroller` counts even when it's fully scrolled, since it's the one
// the delta is destined for anyway.
function wheelTargetScroller(target: Node | null, root: HTMLElement, scroller: HTMLElement): HTMLElement | null {
	for (let node = target instanceof HTMLElement ? target : target?.parentElement; node && node !== root; node = node.parentElement) {
		if (node === scroller) return node
		const overflowY = getComputedStyle(node).overflowY
		if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
	}
	return null
}

/**
 * Sends wheel events that land on nothing to a page's real scroll container.
 *
 * A page whose body scrolls inside an inner container silently drops every wheel that lands outside it -- the margins
 * either side of a centred column, a page header, the empty space under a short table of contents -- and the body just
 * sits there. This forwards those to `scrollRef`. Anything that would scroll on its own is left alone, so an inner
 * list (a table of contents with more rows than it can show) still takes its own wheel until it runs out.
 *
 * `deps` re-binds the listener; pass whatever gates the refs being attached, since they're null until the page renders.
 */
export function useForwardWheelToScroller(
	rootRef: React.RefObject<HTMLElement | null>,
	scrollRef: React.RefObject<HTMLElement | null>,
	deps: unknown,
) {
	React.useEffect(() => {
		const root = rootRef.current
		const scroller = scrollRef.current
		if (!root || !scroller) return
		const onWheel = (e: WheelEvent) => {
			if (wheelTargetScroller(e.target as Node | null, root, scroller)) return
			// forwarding the delta means taking the event over, so this listener can't be passive
			e.preventDefault()
			scroller.scrollTop += e.deltaY
		}
		root.addEventListener('wheel', onWheel, { passive: false })
		return () => root.removeEventListener('wheel', onWheel)
	}, [rootRef, scrollRef, deps])
}
