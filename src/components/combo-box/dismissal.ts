import React from 'react'

// Radix's own dismissal cannot be trusted inside a headlessui dialog: it defers left-click outside-dismissal to
// the click event and skips it when the click never bubbles back to the document, and the dialog panel stops
// click propagation for its own outside-click logic. A modal popover is no better, since disabling outside
// pointer events retargets panel clicks to <html>, which the dialog reads as a backdrop click and closes on. So
// the combo boxes dismiss themselves: any pointerdown outside the box's own trigger and layers closes them, and
// Escape closes them without reaching anything else. Another combo box's trigger counts as outside, so opening one
// closes the other.
// The box's layers are its own popper content and any popper opened after it, such as a popover or tooltip
// spawned from inside it. Every portal mounts to the end of document.body, so a later popper follows the box's own
// in document order, while a popper the box sits inside precedes it and counts as outside.
// `consumeEscape` gets the key first and returns whether it used it, so a step nested inside the popover (a
// grouping's drill-in) backs out on Escape instead of the whole thing closing under it. It cannot be done from
// a handler inside the popover: this listener captures on the document and stops the event there, so nothing
// below ever sees it.
// Returns an `onCloseAutoFocus` guard for the popover content. After a pointerdown closes the box it keeps focus
// where the pointer put it, as Radix's own outside dismissal does. Returning focus to this trigger would read as a
// focus-outside to a popover the same pointer is opening, and close that popover too. The guard returns whether it
// took the event.
export function useComboBoxDismissal(
	open: boolean,
	triggerRef: React.RefObject<HTMLElement | null>,
	close: () => void,
	consumeEscape?: () => boolean,
) {
	const closeRef = React.useRef(close)
	closeRef.current = close
	const consumeRef = React.useRef(consumeEscape)
	consumeRef.current = consumeEscape
	const closedByPointerRef = React.useRef(false)

	React.useEffect(() => {
		if (!open) return
		closedByPointerRef.current = false
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target
			if (!(target instanceof Node)) return
			if (triggerRef.current?.contains(target)) return
			if (target instanceof Element && isOwnLayer(target, triggerRef.current)) return
			closedByPointerRef.current = true
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
	}, [open, triggerRef])

	return React.useCallback((event: Event) => {
		if (!closedByPointerRef.current) return false
		closedByPointerRef.current = false
		event.preventDefault()
		return true
	}, [])
}

const POPPER = '[data-radix-popper-content-wrapper]'

function isOwnLayer(target: Element, trigger: HTMLElement | null) {
	// a sheet's scrim covers everything else, so only one combo box sheet is ever open
	if (target.closest('[data-combobox-sheet]')) return true
	const popper = target.closest(POPPER)
	if (!popper) return false
	const contentId = trigger?.getAttribute('aria-controls')
	const own = contentId ? document.getElementById(contentId)?.closest(POPPER) : null
	// on a sheet the box has no popper, and everything it spawns opened after it
	if (!own) return true
	return popper === own || !!(own.compareDocumentPosition(popper) & Node.DOCUMENT_POSITION_FOLLOWING)
}
