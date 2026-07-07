import React from 'react'

export function useTailingScroll() {
	const scrollAreaRef = React.useRef<HTMLDivElement>(null)
	const contentRef = React.useRef<HTMLDivElement>(null)
	const bottomRef = React.useRef<HTMLDivElement>(null)
	const tailing = React.useRef(true)
	const [showScrollButton, setShowScrollButton] = React.useState(false)
	const [isAtTop, setIsAtTop] = React.useState(true)

	const getViewport = React.useCallback(() => {
		return scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null
	}, [])

	const checkIfAtBottom = React.useCallback(() => {
		const viewport = getViewport()
		if (!viewport) return false
		const { scrollHeight, scrollTop, clientHeight } = viewport
		return scrollHeight - scrollTop - clientHeight < 10
	}, [getViewport])

	const checkIfAtTop = React.useCallback(() => {
		const viewport = getViewport()
		if (!viewport) return false
		return viewport.scrollTop < 10
	}, [getViewport])

	const scrollToBottom = React.useCallback(() => {
		const viewport = getViewport()
		if (viewport) {
			viewport.scrollTop = viewport.scrollHeight
		}
		tailing.current = true
	}, [getViewport])

	// When prepending older content at the top, capture the pre-growth scroll metrics so the next content
	// growth can be offset by the added height, keeping the previously-visible items anchored in place.
	const prependAnchor = React.useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
	const anchorForPrepend = React.useCallback(() => {
		const viewport = getViewport()
		if (!viewport) return
		prependAnchor.current = { scrollHeight: viewport.scrollHeight, scrollTop: viewport.scrollTop }
	}, [getViewport])

	// ResizeObserver on content for auto-scroll when content grows
	// Also handles visibility change to resume scroll when tab refocuses
	React.useEffect(() => {
		const contentEl = contentRef.current
		if (!contentEl) return

		const resizeObserver = new ResizeObserver(() => {
			requestAnimationFrame(() => {
				const anchor = prependAnchor.current
				if (anchor) {
					prependAnchor.current = null
					const viewport = getViewport()
					if (viewport) {
						viewport.scrollTop = anchor.scrollTop + (viewport.scrollHeight - anchor.scrollHeight)
						return
					}
				}
				if (tailing.current && !checkIfAtBottom()) {
					scrollToBottom()
				}
			})
		})

		const onVisibilityChange = () => {
			if (document.hidden || !tailing.current) return
			scrollToBottom()
		}

		requestAnimationFrame(() => {
			scrollToBottom()
		})

		resizeObserver.observe(contentEl)
		document.addEventListener('visibilitychange', onVisibilityChange)

		return () => {
			resizeObserver.disconnect()
			document.removeEventListener('visibilitychange', onVisibilityChange)
		}
	}, [checkIfAtBottom, scrollToBottom, getViewport])

	// Scroll event listener for tailing state
	React.useEffect(() => {
		const viewport = getViewport()
		if (!viewport) return

		const handleScroll = () => {
			const atBottom = checkIfAtBottom()
			setShowScrollButton(!atBottom)
			setIsAtTop(checkIfAtTop())
			tailing.current = atBottom
		}

		viewport.addEventListener('scroll', handleScroll)
		handleScroll()

		return () => viewport.removeEventListener('scroll', handleScroll)
	}, [getViewport, checkIfAtBottom, checkIfAtTop])

	return {
		scrollAreaRef,
		contentRef,
		bottomRef,
		showScrollButton,
		isAtTop,
		scrollToBottom,
		anchorForPrepend,
		tailing,
	}
}
