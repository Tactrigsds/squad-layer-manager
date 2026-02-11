import React from 'react'

export function useTailingScroll() {
	const scrollAreaRef = React.useRef<HTMLDivElement>(null)
	const contentRef = React.useRef<HTMLDivElement>(null)
	const bottomRef = React.useRef<HTMLDivElement>(null)
	const tailing = React.useRef(true)
	const [showScrollButton, setShowScrollButton] = React.useState(false)

	const getViewport = React.useCallback(() => {
		return scrollAreaRef.current?.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null
	}, [])

	const checkIfAtBottom = React.useCallback(() => {
		const viewport = getViewport()
		if (!viewport) return false
		const { scrollHeight, scrollTop, clientHeight } = viewport
		return scrollHeight - scrollTop - clientHeight < 10
	}, [getViewport])

	const scrollToBottom = React.useCallback(() => {
		const viewport = getViewport()
		if (viewport) {
			viewport.scrollTop = viewport.scrollHeight
		}
		tailing.current = true
	}, [getViewport])

	// ResizeObserver on content for auto-scroll when content grows
	// Also handles visibility change to resume scroll when tab refocuses
	React.useEffect(() => {
		const contentEl = contentRef.current
		if (!contentEl) return

		const resizeObserver = new ResizeObserver(() => {
			requestAnimationFrame(() => {
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
	}, [checkIfAtBottom, scrollToBottom])

	// Scroll event listener for tailing state
	React.useEffect(() => {
		const viewport = getViewport()
		if (!viewport) return

		const handleScroll = () => {
			const atBottom = checkIfAtBottom()
			setShowScrollButton(!atBottom)
			tailing.current = atBottom
		}

		viewport.addEventListener('scroll', handleScroll)
		handleScroll()

		return () => viewport.removeEventListener('scroll', handleScroll)
	}, [getViewport, checkIfAtBottom])

	return {
		scrollAreaRef,
		contentRef,
		bottomRef,
		showScrollButton,
		scrollToBottom,
		tailing,
	}
}
