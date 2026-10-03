import * as React from 'react'

export type Size = { width: number; height: number }

const ZERO: Size = { width: 0, height: 0 }

// React reads the snapshot on every render and again after each commit, so it is cached: reading clientWidth there
// would force a layout mid-render every time the chart's data changes. The observer refreshes it after layouts the
// browser runs anyway. The cached object keeps its identity until a dimension changes, which is what
// useSyncExternalStore compares.
const measuredSizes = new WeakMap<HTMLElement, Size>()

function read(el: HTMLElement): Size {
	return { width: el.clientWidth, height: el.clientHeight }
}

export function useMeasuredSize(el: HTMLElement | null): Size {
	const subscribe = React.useCallback(
		(onResize: () => void) => {
			if (!el) return () => {}
			const observer = new ResizeObserver(() => {
				const next = read(el)
				const prev = measuredSizes.get(el)
				if (prev && prev.width === next.width && prev.height === next.height) return
				measuredSizes.set(el, next)
				onResize()
			})
			observer.observe(el)
			return () => observer.disconnect()
		},
		[el],
	)
	const getSnapshot = React.useCallback(() => {
		if (!el) return ZERO
		let size = measuredSizes.get(el)
		if (size === undefined) {
			size = read(el)
			measuredSizes.set(el, size)
		}
		return size
	}, [el])
	return React.useSyncExternalStore(subscribe, getSnapshot, () => ZERO)
}

export function useMeasuredWidth(el: HTMLElement | null) {
	return useMeasuredSize(el).width
}
