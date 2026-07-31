import React from 'react'

// Radix's own dismissal cannot be trusted inside a headlessui dialog: it defers left-click outside-dismissal to
// the click event and skips it when the click never bubbles back to the document, and the dialog panel stops
// click propagation for its own outside-click logic. A modal popover is no better, since disabling outside
// pointer events retargets panel clicks to <html>, which the dialog reads as a backdrop click and closes on. So
// the combo boxes dismiss themselves: any pointerdown outside the popper content and the trigger closes them, and
// Escape closes them without reaching anything else.
export function useComboBoxDismissal(open: boolean, close: () => void) {
	const closeRef = React.useRef(close)
	closeRef.current = close

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
