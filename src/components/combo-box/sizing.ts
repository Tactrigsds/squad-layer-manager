import React from 'react'

// Keeps a content-sized popover from shrinking while it is open. cmdk unmounts the rows a query filters out, so
// a popover sized to its widest row would otherwise narrow on every keystroke and jump its edge around. It can
// still grow, for options that load or search results that arrive after it opens.
// Each growth is written straight to min-width, which keeps it out of React's render cycle and costs no forced
// layout: the observer reports sizes the browser already computed. The popover remounts on each opening, so the
// width starts from its content again every time.
export function useGrowOnlyWidth<E extends HTMLElement>() {
	const observerRef = React.useRef<ResizeObserver | null>(null)
	return React.useCallback((node: E | null) => {
		observerRef.current?.disconnect()
		observerRef.current = null
		if (!node) return
		let widest = 0
		const observer = new ResizeObserver((entries) => {
			const width = entries[0].borderBoxSize[0].inlineSize
			if (width <= widest) return
			widest = width
			// min-width beats max-width, so it carries the viewport limit itself
			node.style.minWidth = `min(${width}px, var(--radix-popover-content-available-width))`
		})
		observer.observe(node, { box: 'border-box' })
		observerRef.current = observer
	}, [])
}
