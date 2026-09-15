import React from 'react'

const EDGE_THRESHOLD_PX = 12

function distanceFromBottom(viewport: HTMLElement) {
	return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
}

// the viewport lives in state, which makes React Compiler treat it as a value that must not be mutated. scrolling
// a DOM node is a side effect on the document, not a state write, so the writes go through here.
function scrollTo(viewport: HTMLElement, top: number) {
	viewport.scrollTop = top
}

function setOverflowAnchor(viewport: HTMLElement, value: 'auto' | 'none') {
	viewport.style.overflowAnchor = value
}

/**
 * Keeps a Radix ScrollArea pinned to the bottom as content grows, and lets go when the reader scrolls away.
 *
 * Every scroll event decides tailing from where it landed. The one exception is the event our own pin
 * produces: it fires a frame later and can observe growth that arrived in between, which would read as the
 * reader having scrolled away during a burst. The pin records the position it wrote, and the next scroll
 * event landing there is skipped. Any other scroll, whatever caused it, lands where geometry gives the right
 * answer: a clamp keeps a reader at the bottom at the bottom, and a find bar, focus or gesture that carries them
 * away is them leaving.
 *
 * The browser's scroll anchoring is on only while the reader is parked. There it keeps the rows they are reading
 * still as rows above resize or a capped buffer drops rows off the top. While tailing that same correction would
 * scroll them away from the bottom, so the pin does the work instead.
 */
export function useTailingScroll() {
	const [viewport, setViewport] = React.useState<HTMLElement | null>(null)
	const [content, setContent] = React.useState<HTMLElement | null>(null)
	const [tailing, setTailingState] = React.useState(true)
	const [isAtTop, setIsAtTop] = React.useState(true)
	const tailingRef = React.useRef(true)
	const pinnedTop = React.useRef<number | null>(null)

	const scrollAreaRef = React.useCallback((node: HTMLElement | null) => {
		setViewport(node?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]') ?? null)
	}, [])

	const contentRef = React.useCallback((node: HTMLElement | null) => setContent(node), [])

	const setTailing = React.useCallback((value: boolean) => {
		tailingRef.current = value
		setTailingState(value)
	}, [])

	const pin = React.useCallback((viewport: HTMLElement) => {
		scrollTo(viewport, viewport.scrollHeight - viewport.clientHeight)
		pinnedTop.current = viewport.scrollTop
	}, [])

	const scrollToBottom = React.useCallback(() => {
		setTailing(true)
		if (viewport) pin(viewport)
	}, [viewport, setTailing, pin])

	const scrollBy = React.useCallback(
		(delta: number) => {
			if (viewport) scrollTo(viewport, viewport.scrollTop + delta)
		},
		[viewport],
	)

	React.useEffect(() => {
		if (!viewport || !content) return
		const settle = () => {
			if (tailingRef.current) pin(viewport)
		}
		// content growth and viewport resize (panel, window) both need the same correction
		const resizeObserver = new ResizeObserver(settle)
		resizeObserver.observe(content)
		resizeObserver.observe(viewport)
		settle()
		return () => resizeObserver.disconnect()
	}, [viewport, content, pin])

	React.useEffect(() => {
		if (!viewport) return
		setOverflowAnchor(viewport, tailing ? 'none' : 'auto')
	}, [viewport, tailing])

	React.useEffect(() => {
		if (!viewport) return
		const onScroll = () => {
			setIsAtTop(viewport.scrollTop <= EDGE_THRESHOLD_PX)
			const pinned = pinnedTop.current
			pinnedTop.current = null
			if (pinned !== null && Math.abs(viewport.scrollTop - pinned) < 1) return
			setTailing(distanceFromBottom(viewport) <= EDGE_THRESHOLD_PX)
		}
		viewport.addEventListener('scroll', onScroll, { passive: true })
		return () => viewport.removeEventListener('scroll', onScroll)
	}, [viewport, setTailing])

	return { scrollAreaRef, contentRef, content, showScrollButton: !tailing, isAtTop, scrollToBottom, scrollBy }
}
