import React from 'react'

/**
 * How many of a row's items fit inline, with the rest folding into an overflow menu.
 *
 * - `boxRef`: the row. It must take its width from its parent rather than its content (`flex-1 min-w-0`).
 * - `measureRef`: a hidden row holding every item, then each variant of the overflow trigger. Item widths are read from
 *   it, so what is shown inline never feeds back into the measurement.
 * - `trailingRef`: an optional element after the items inside the row, whose width is reserved.
 */
export function usePriorityPlus(itemCount: number, enabled: boolean) {
	const boxRef = React.useRef<HTMLDivElement>(null)
	const measureRef = React.useRef<HTMLDivElement>(null)
	const trailingRef = React.useRef<HTMLButtonElement>(null)
	const [fitCount, setFitCount] = React.useState(itemCount)

	React.useLayoutEffect(() => {
		const box = boxRef.current
		const row = measureRef.current
		if (!enabled || !box || !row) return

		function evaluate() {
			const children = row!.children
			const gap = parseFloat(getComputedStyle(box!).columnGap) || 0
			const trailing = trailingRef.current
			const available = box!.clientWidth - (trailing ? trailing.getBoundingClientRect().width + gap : 0)
			let trigger = 0
			for (let i = itemCount; i < children.length; i++) trigger = Math.max(trigger, children[i].getBoundingClientRect().width)

			let all = 0
			for (let i = 0; i < itemCount; i++) all += children[i].getBoundingClientRect().width + (i > 0 ? gap : 0)
			if (all <= available) return setFitCount(itemCount)

			let used = trigger
			let count = 0
			while (count < itemCount) {
				used += children[count].getBoundingClientRect().width + gap
				if (used > available) break
				count++
			}
			setFitCount(count)
		}

		const observer = new ResizeObserver(evaluate)
		observer.observe(box)
		observer.observe(row)
		if (trailingRef.current) observer.observe(trailingRef.current)
		evaluate()
		return () => observer.disconnect()
	}, [itemCount, enabled])

	return { fitCount: Math.min(fitCount, itemCount), boxRef, measureRef, trailingRef }
}
