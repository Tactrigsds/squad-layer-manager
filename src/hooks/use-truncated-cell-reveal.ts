/**
 * Shows the full contents of a table cell that cuts its text off, spreadsheet style: while a mouse rests on such a
 * cell, a copy of its contents with truncation turned off is laid over it and the cells beside it.
 *
 * One overlay serves the whole table, driven by delegated listeners and written straight to the DOM, so hovering
 * never re-renders React. The overlay ignores the pointer, so a click, shift+click or right-click still lands on the
 * cell underneath. It closes when the pointer leaves the cell, on any press, and on any scroll, since a scroll moves
 * the cell out from under it without the pointer leaving. The next move brings it back for whatever cell is then
 * under the pointer.
 */
import * as React from 'react'

export function useTruncatedCellReveal(
	tableRef: React.RefObject<HTMLTableElement | null>,
	overlayRef: React.RefObject<HTMLDivElement | null>,
) {
	React.useEffect(() => {
		const table = tableRef.current
		const overlay = overlayRef.current
		if (!table || !overlay) return
		// the cell last measured under the pointer, so a cell is measured once per visit rather than on every move
		let checked: HTMLTableCellElement | null = null

		const hide = () => {
			if (overlay.hidden) return
			overlay.hidden = true
			overlay.replaceChildren()
		}

		// after a scroll or a press the cell under the pointer is measured again on the next move
		const reset = () => {
			checked = null
			hide()
		}

		const show = (cell: HTMLTableCellElement) => {
			// a hidden element has no offsetParent, so it is unhidden before it is placed
			overlay.hidden = false
			const parent = overlay.offsetParent
			if (!parent) {
				overlay.hidden = true
				return
			}
			const cellRect = cell.getBoundingClientRect()
			const parentRect = parent.getBoundingClientRect()
			const style = getComputedStyle(cell)
			overlay.replaceChildren(...[...cell.childNodes].map((node) => node.cloneNode(true)))
			overlay.style.top = `${cellRect.top - parentRect.top + parent.scrollTop}px`
			overlay.style.left = `${cellRect.left - parentRect.left + parent.scrollLeft}px`
			overlay.style.height = `${cellRect.height}px`
			overlay.style.minWidth = `${cellRect.width}px`
			overlay.style.paddingInline = `${style.paddingLeft} ${style.paddingRight}`
			overlay.style.fontSize = style.fontSize
			// the row's tint is translucent over the panel, so it is laid over an opaque panel to hide the cells beneath
			overlay.style.background = `linear-gradient(${style.backgroundColor}, ${style.backgroundColor}), var(--panel)`
			// a cell near the table's far edge would push its contents out of the table, so it grows back over the table instead
			const tableRect = table.getBoundingClientRect()
			const overflow = cellRect.left + overlay.offsetWidth - tableRect.right
			if (overflow > 0) {
				const left = Math.max(tableRect.left, cellRect.left - overflow)
				overlay.style.left = `${left - parentRect.left + parent.scrollLeft}px`
			}
		}

		const onPointerMove = (e: PointerEvent) => {
			if (e.pointerType !== 'mouse') return
			const found = (e.target as Element).closest('td')
			const cell = found && table.contains(found) ? found : null
			if (cell === checked) return
			checked = cell
			hide()
			if (cell && isTruncated(cell)) show(cell)
		}

		table.addEventListener('pointermove', onPointerMove)
		table.addEventListener('pointerleave', reset)
		table.addEventListener('pointerdown', reset)
		window.addEventListener('scroll', reset, { capture: true, passive: true })
		return () => {
			table.removeEventListener('pointermove', onPointerMove)
			table.removeEventListener('pointerleave', reset)
			table.removeEventListener('pointerdown', reset)
			window.removeEventListener('scroll', reset, { capture: true })
			reset()
		}
	}, [tableRef, overlayRef])
}

// the cell, or anything in it, has more content than room
function isTruncated(cell: HTMLElement): boolean {
	if (cell.scrollWidth > cell.clientWidth) return true
	for (const el of cell.querySelectorAll<HTMLElement>('*')) {
		if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth) return true
	}
	return false
}
