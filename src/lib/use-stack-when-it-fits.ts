import React from 'react'

// Entering costs a relayout and moves what the reader was looking at, so it asks for real headroom, while
// leaving only needs the pair to stop fitting. One number both ways would flip on a pixel of drift.
const ENTER_HEADROOM_PX = 64
const LEAVE_SLACK_PX = 8
// A resize is continuous and each reading relays out both sections, so this waits for the drag to stop rather
// than tracking it. Only the first reading is taken immediately.
const SETTLE_MS = 500

/**
 * Whether two sections should be shown together or one at a time behind tabs, from whether they both fit.
 *
 * It starts them together, and that is what keeps the answer honest rather than merely convenient: shown
 * together both sections are laid out, so the first reading measures both, where the one behind an inactive
 * tab is `display: none` and measures nothing. Reading it the other way round -- tabs first -- can only guess
 * at the hidden section, and a panel that guesses wrong stays tabbed until the reader happens to open the
 * other tab and it suddenly rearranges under them.
 *
 * That first reading is taken before paint, so a pair that does not fit is behind tabs by the time anything
 * is on screen. Everything after it is debounced.
 */
export function useStackWhenItFits(opts: {
	enabled: boolean
	// the box the two sections have to fit inside, read at the moment of measuring
	getBudgetEl: () => HTMLElement | null | undefined
}) {
	const { enabled } = opts
	const getBudgetEl = React.useRef(opts.getBudgetEl)
	getBudgetEl.current = opts.getBudgetEl

	const firstRef = React.useRef<HTMLDivElement>(null)
	const secondRef = React.useRef<HTMLDivElement>(null)
	const measured = React.useRef({ first: 0, second: 0 })
	const takenFirstReading = React.useRef(false)
	const [stacked, setStacked] = React.useState(true)

	React.useLayoutEffect(() => {
		// nothing to measure, and nothing to reset: what is returned is already gated on `enabled`
		if (!enabled) return
		let timer: ReturnType<typeof setTimeout> | undefined

		function evaluate() {
			const budgetEl = getBudgetEl.current()
			if (!budgetEl) return
			const budget = budgetEl.clientHeight
			// zero means "not on screen to measure", which is not news about how tall that section is
			if (firstRef.current?.offsetHeight) measured.current.first = firstRef.current.offsetHeight
			if (secondRef.current?.offsetHeight) measured.current.second = secondRef.current.offsetHeight
			const needed = measured.current.first + measured.current.second
			if (needed === 0) return
			setStacked((current) => (current ? needed <= budget + LEAVE_SLACK_PX : needed + ENTER_HEADROOM_PX <= budget))
		}

		function schedule() {
			clearTimeout(timer)
			timer = setTimeout(evaluate, SETTLE_MS)
		}

		const observer = new ResizeObserver(schedule)
		for (const el of [getBudgetEl.current(), firstRef.current, secondRef.current]) {
			if (el) observer.observe(el)
		}
		if (takenFirstReading.current) schedule()
		else {
			takenFirstReading.current = true
			evaluate()
		}
		return () => {
			clearTimeout(timer)
			observer.disconnect()
		}
		// `stacked` re-attaches the observers, since switching replaces the elements they were watching
	}, [enabled, stacked])

	return { stacked: enabled && stacked, firstRef, secondRef }
}
