import * as React from 'react'

import type * as Flt from '@/lib/floating'

// A pinned tooltip sits a short gap away from the pointer, so moving onto it leaves both it and the trigger for a
// frame or two. A close waits this long for the pointer to arrive at the other one.
const LEAVE_GRACE_MS = 150

type Mode = 'closed' | 'follow' | 'pinned'

export type FollowTooltip = ReturnType<typeof useFollowTooltip>

/**
 * Drives a `TrackingTooltip` from a single trigger.
 *
 * Hovering the trigger opens a tooltip that follows the pointer, with no delay. Clicking freezes it where the pointer is and lets
 * the pointer reach it, which is the only way to use content containing links or buttons; from there it closes when
 * the pointer leaves both it and the trigger, when something outside is pressed, or when the trigger is clicked
 * again. That last one also blocks hover from reopening it until the pointer leaves the trigger, so the click that
 * dismissed it does not undo itself.
 *
 * Touch has no hover, so a tap goes straight to the frozen state and only an outside press or a second tap closes it.
 */
export function useFollowTooltip() {
	const id = React.useId()
	const [mode, setMode] = React.useState<Mode>('closed')
	const [anchor, setAnchor] = React.useState<Flt.Point | null>(null)
	const triggerRef = React.useRef<HTMLButtonElement | null>(null)
	const contentRef = React.useRef<HTMLDivElement | null>(null)
	const overTrigger = React.useRef(false)
	const overContent = React.useRef(false)
	const hoverBlocked = React.useRef(false)
	const openedByKeyboard = React.useRef(false)
	const lastPointerType = React.useRef('mouse')
	// a pointer press always lands before the focus it causes, so an unclaimed focus is a keyboard one
	const focusFromPointer = React.useRef(false)
	const closeTimer = React.useRef<number | null>(null)

	const cancelClose = React.useCallback(() => {
		if (closeTimer.current === null) return
		window.clearTimeout(closeTimer.current)
		closeTimer.current = null
	}, [])

	const close = React.useCallback(() => {
		cancelClose()
		openedByKeyboard.current = false
		setAnchor(null)
		setMode('closed')
	}, [cancelClose])

	const scheduleClose = React.useCallback(() => {
		cancelClose()
		closeTimer.current = window.setTimeout(() => {
			closeTimer.current = null
			if (overTrigger.current || overContent.current) return
			close()
		}, LEAVE_GRACE_MS)
	}, [cancelClose, close])

	const pin = React.useCallback(
		(at: Flt.Point | null) => {
			cancelClose()
			setAnchor(at ?? triggerCorner(triggerRef.current))
			setMode('pinned')
		},
		[cancelClose],
	)

	React.useEffect(() => {
		if (mode === 'closed') return
		const onKeyDown = (ev: KeyboardEvent) => {
			if (ev.key === 'Escape') close()
		}
		document.addEventListener('keydown', onKeyDown, true)
		return () => document.removeEventListener('keydown', onKeyDown, true)
	}, [mode, close])

	React.useEffect(() => {
		if (mode !== 'pinned') return
		const onPointerDown = (ev: PointerEvent) => {
			const target = ev.target as Node | null
			if (!target) return
			if (triggerRef.current?.contains(target) || contentRef.current?.contains(target)) return
			close()
		}
		document.addEventListener('pointerdown', onPointerDown, true)
		return () => document.removeEventListener('pointerdown', onPointerDown, true)
	}, [mode, close])

	React.useEffect(() => cancelClose, [cancelClose])

	const triggerProps = {
		ref: triggerRef,
		'aria-describedby': mode === 'closed' ? undefined : id,
		'aria-expanded': mode === 'pinned',
		onPointerDown: (e: React.PointerEvent) => {
			lastPointerType.current = e.pointerType
			focusFromPointer.current = true
		},
		onPointerEnter: (e: React.PointerEvent) => {
			if (e.pointerType === 'touch') return
			overTrigger.current = true
			cancelClose()
			if (mode !== 'closed' || hoverBlocked.current) return
			setMode('follow')
		},
		onPointerLeave: (e: React.PointerEvent) => {
			if (e.pointerType === 'touch') return
			overTrigger.current = false
			hoverBlocked.current = false
			if (mode === 'pinned') scheduleClose()
			else if (mode === 'follow') close()
		},
		onClick: (e: React.MouseEvent) => {
			if (mode === 'pinned') {
				hoverBlocked.current = lastPointerType.current !== 'touch'
				close()
				return
			}
			openedByKeyboard.current = false
			// a keyboard-triggered click reports no coordinates, so fall back to the trigger itself
			pin(e.detail === 0 ? null : { x: e.clientX, y: e.clientY })
		},
		onFocus: () => {
			const byPointer = focusFromPointer.current
			focusFromPointer.current = false
			if (byPointer || mode !== 'closed') return
			openedByKeyboard.current = true
			pin(null)
		},
		onBlur: () => {
			focusFromPointer.current = false
			if (openedByKeyboard.current) close()
		},
	}

	const contentProps = {
		id,
		nodeRef: contentRef,
		anchor,
		interactive: mode === 'pinned',
		onPointerEnter: (e: React.PointerEvent) => {
			if (e.pointerType === 'touch') return
			overContent.current = true
			cancelClose()
		},
		onPointerLeave: (e: React.PointerEvent) => {
			if (e.pointerType === 'touch') return
			overContent.current = false
			scheduleClose()
		},
	}

	return { open: mode !== 'closed', pinned: mode === 'pinned', triggerProps, contentProps }
}

function triggerCorner(el: HTMLElement | null): Flt.Point | null {
	if (!el) return null
	const rect = el.getBoundingClientRect()
	return { x: rect.left, y: rect.bottom }
}
