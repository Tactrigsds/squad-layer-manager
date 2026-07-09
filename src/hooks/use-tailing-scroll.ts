import React from 'react'

const EDGE_THRESHOLD_PX = 12
// how long after a user gesture we keep attributing scroll events to the user (covers momentum/smooth scrolling)
const SCROLL_IDLE_MS = 250
// a prepend that never materializes (empty page, aborted fetch) must not leave a stale anchor around
const PREPEND_ANCHOR_TTL_MS = 3000

const USER_INTENT_EVENTS = ['wheel', 'touchstart', 'touchmove', 'pointerdown', 'keydown'] as const

type PrependAnchor = { scrollHeight: number; scrollTop: number; takenAt: number }

function distanceFromBottom(viewport: HTMLElement) {
	return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
}

function maxScrollTop(viewport: HTMLElement) {
	return viewport.scrollHeight - viewport.clientHeight
}

/**
 * Keeps a Radix ScrollArea pinned to the bottom as content grows, and lets go only when the user
 * deliberately scrolls away.
 *
 * The tailing flag is driven by user gestures rather than by raw scroll events: programmatic
 * corrections, browser scroll anchoring and clamping on resize all emit scroll events that are
 * otherwise indistinguishable from a user scrolling up, which is what made the previous
 * implementation silently stop following new events.
 */
export function useTailingScroll() {
	const [viewport, setViewport] = React.useState<HTMLElement | null>(null)
	const [root, setRoot] = React.useState<HTMLElement | null>(null)
	const [content, setContent] = React.useState<HTMLElement | null>(null)
	const [showScrollButton, setShowScrollButton] = React.useState(false)
	const [isAtTop, setIsAtTop] = React.useState(true)
	const tailing = React.useRef(true)
	const prependAnchor = React.useRef<PrependAnchor | null>(null)

	const scrollAreaRef = React.useCallback((node: HTMLElement | null) => {
		const viewport = node?.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]') ?? null
		// browser scroll anchoring shifts scrollTop when content above the viewport changes size, which
		// both fights our own prepend anchoring and fires spurious scroll events. we handle it ourselves.
		if (viewport) viewport.style.overflowAnchor = 'none'
		setRoot(node)
		setViewport(viewport)
	}, [])

	const contentRef = React.useCallback((node: HTMLElement | null) => setContent(node), [])

	const scrollToBottom = React.useCallback(() => {
		tailing.current = true
		prependAnchor.current = null
		if (viewport) viewport.scrollTop = maxScrollTop(viewport)
	}, [viewport])

	// captures the pre-growth metrics so the next content growth can be offset by the added height,
	// keeping the previously-visible items anchored in place.
	const anchorForPrepend = React.useCallback(() => {
		if (!viewport) return
		prependAnchor.current = { scrollHeight: viewport.scrollHeight, scrollTop: viewport.scrollTop, takenAt: performance.now() }
	}, [viewport])

	React.useEffect(() => {
		if (!viewport || !content) return

		const settle = () => {
			const anchor = prependAnchor.current
			if (anchor && performance.now() - anchor.takenAt > PREPEND_ANCHOR_TTL_MS) prependAnchor.current = null
			else if (anchor) {
				// wait for the growth we anchored for; unrelated resizes must not consume the anchor
				if (viewport.scrollHeight === anchor.scrollHeight) return
				prependAnchor.current = null
				viewport.scrollTop = anchor.scrollTop + (viewport.scrollHeight - anchor.scrollHeight)
				return
			}
			if (tailing.current) viewport.scrollTop = maxScrollTop(viewport)
		}

		// content growth, viewport resize (panel/window) and clamping all need the same correction
		const resizeObserver = new ResizeObserver(settle)
		resizeObserver.observe(content)
		resizeObserver.observe(viewport)

		// resize observers don't run while the tab is hidden, so content can outgrow our scroll position
		const onVisibilityChange = () => {
			if (!document.hidden) settle()
		}
		document.addEventListener('visibilitychange', onVisibilityChange)
		settle()

		return () => {
			resizeObserver.disconnect()
			document.removeEventListener('visibilitychange', onVisibilityChange)
		}
	}, [viewport, content])

	React.useEffect(() => {
		if (!viewport) return
		const intentTarget = root ?? viewport

		let userScrolling = false
		let idleTimeout: ReturnType<typeof setTimeout> | undefined

		const markUserActive = () => {
			userScrolling = true
			clearTimeout(idleTimeout)
			idleTimeout = setTimeout(() => userScrolling = false, SCROLL_IDLE_MS)
		}

		const onScroll = () => {
			const fromBottom = distanceFromBottom(viewport)
			setShowScrollButton(fromBottom > EDGE_THRESHOLD_PX)
			setIsAtTop(viewport.scrollTop <= EDGE_THRESHOLD_PX)
			if (!userScrolling) return
			markUserActive()
			tailing.current = fromBottom <= EDGE_THRESHOLD_PX
		}

		viewport.addEventListener('scroll', onScroll, { passive: true })
		for (const event of USER_INTENT_EVENTS) intentTarget.addEventListener(event, markUserActive, { passive: true })
		onScroll()

		return () => {
			clearTimeout(idleTimeout)
			viewport.removeEventListener('scroll', onScroll)
			for (const event of USER_INTENT_EVENTS) intentTarget.removeEventListener(event, markUserActive)
		}
	}, [viewport, root])

	return { scrollAreaRef, contentRef, showScrollButton, isAtTop, scrollToBottom, anchorForPrepend }
}
