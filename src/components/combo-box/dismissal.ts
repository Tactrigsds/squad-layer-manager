import React from 'react'

// Radix's own dismissal cannot be trusted inside a headlessui dialog: it defers left-click outside-dismissal to
// the click event and skips it when the click never bubbles back to the document, and the dialog panel stops
// click propagation for its own outside-click logic. A modal popover is no better, since disabling outside
// pointer events retargets panel clicks to <html>, which the dialog reads as a backdrop click and closes on. So
// the combo boxes dismiss themselves: any pointerdown outside the popper content and the trigger closes them, and
// Escape closes them without reaching anything else.
// `consumeEscape` gets the key first and returns whether it used it, so a step nested inside the popover (a
// grouping's drill-in) backs out on Escape instead of the whole thing closing under it. It cannot be done from
// a handler inside the popover: this listener captures on the document and stops the event there, so nothing
// below ever sees it.
export function useComboBoxDismissal(open: boolean, close: () => void, consumeEscape?: () => boolean) {
	const closeRef = React.useRef(close)
	closeRef.current = close
	const consumeRef = React.useRef(consumeEscape)
	consumeRef.current = consumeEscape

	React.useEffect(() => {
		if (!open) return
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target
			if (target instanceof Element && target.closest('[data-radix-popper-content-wrapper], [data-combobox-trigger]')) return
			closeRef.current()
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return
			event.stopPropagation()
			if (consumeRef.current?.()) return
			closeRef.current()
		}
		document.addEventListener('pointerdown', onPointerDown, { capture: true })
		document.addEventListener('keydown', onKeyDown, { capture: true })
		return () => {
			document.removeEventListener('pointerdown', onPointerDown, { capture: true })
			document.removeEventListener('keydown', onKeyDown, { capture: true })
		}
	}, [open])
}
