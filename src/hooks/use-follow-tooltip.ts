import * as React from 'react'

import type * as Flt from '@/lib/floating'

// A pinned tooltip sits a short gap away from the pointer, so moving onto it leaves both it and the trigger for a
// frame or two. A close waits this long for the pointer to arrive at the other one.
const LEAVE_GRACE_MS = 150

// Once one tip has been read, a neighbouring one opens at once rather than making the reader wait again at every
// step along a row of buttons. Shared across every trigger, which is what makes a toolbar feel like one surface.
const SKIP_DELAY_MS = 300

// How long a help tip waits for the pointer to settle. Long enough that sweeping across a toolbar sets nothing
// off, short enough that stopping on a control still feels answered.
export const HELP_TIP_DELAY_MS = 300
let lastShownEndedAt = 0

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
 * `pinnable: false` is for content with nothing to reach, where freezing a surface under the pointer would only be
 * in the way: a mouse click dismisses it instead, as it would a Radix tooltip. Touch still freezes it, since a tap
 * is the only way to open one at all.
 *
 * `delayMs` holds a hover back until the pointer has settled, so tips do not flicker up as the pointer crosses a
 * row of buttons on its way somewhere else. Only hover waits: a click, a tap and a keyboard focus are all
 * deliberate, and open at once.
 *
 * Touch has no hover, so a tap goes straight to the frozen state and only an outside press or a second tap closes it.
 */
export function useFollowTooltip(opts?: { pinnable?: boolean; delayMs?: number }) {
	const pinnable = opts?.pinnable ?? true
	const delayMs = opts?.delayMs ?? 0
	const id = React.useId()
	const [mode, setMode] = React.useState<Mode>('closed')
	const [anchor, setAnchor] = React.useState<Flt.Point | null>(null)
	const triggerRef = React.useRef<HTMLElement | null>(null)
	const contentRef = React.useRef<HTMLDivElement | null>(null)
	const overTrigger = React.useRef(false)
	const overContent = React.useRef(false)
	const hoverBlocked = React.useRef(false)
	const openedByKeyboard = React.useRef(false)
	const lastPointerType = React.useRef('mouse')
	// a pointer press always lands before the focus it causes, so an unclaimed focus is a keyboard one
	const focusFromPointer = React.useRef(false)
	const closeTimer = React.useRef<number | null>(null)
	const openTimer = React.useRef<number | null>(null)

	const cancelOpen = React.useCallback(() => {
		if (openTimer.current === null) return
		window.clearTimeout(openTimer.current)
		openTimer.current = null
	}, [])

	// a callback ref rather than the ref object, so it attaches to a trigger of any element type
	const setTrigger = React.useCallback((node: HTMLElement | null) => {
		triggerRef.current = node
	}, [])

	const cancelClose = React.useCallback(() => {
		if (closeTimer.current === null) return
		window.clearTimeout(closeTimer.current)
		closeTimer.current = null
	}, [])

	const close = React.useCallback(() => {
		cancelClose()
		cancelOpen()
		openedByKeyboard.current = false
		setAnchor(null)
		setMode('closed')
	}, [cancelClose, cancelOpen])

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
			cancelOpen()
			setAnchor(at ?? triggerCorner(triggerRef.current))
			setMode('pinned')
		},
		[cancelClose, cancelOpen],
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

	React.useEffect(() => {
		if (mode === 'closed') return
		// the moment it stopped being shown, which is what the next trigger's skip window is measured from
		return () => {
			lastShownEndedAt = Date.now()
		}
	}, [mode])

	React.useEffect(
		() => () => {
			cancelClose()
			cancelOpen()
		},
		[cancelClose, cancelOpen],
	)

	const triggerProps = {
		ref: setTrigger,
		'aria-describedby': mode === 'closed' ? undefined : id,
		// only a pinnable trigger expands into something; a plain tooltip is described by its content, not disclosed
		'aria-expanded': pinnable ? mode === 'pinned' : undefined,
		onPointerDown: (e: React.PointerEvent) => {
			lastPointerType.current = e.pointerType
			focusFromPointer.current = true
		},
		onPointerEnter: (e: React.PointerEvent) => {
			if (e.pointerType === 'touch') return
			overTrigger.current = true
			cancelClose()
			if (mode !== 'closed' || hoverBlocked.current || openTimer.current !== null) return
			if (delayMs === 0 || Date.now() - lastShownEndedAt < SKIP_DELAY_MS) {
				setMode('follow')
				return
			}
			openTimer.current = window.setTimeout(() => {
				openTimer.current = null
				if (overTrigger.current) setMode('follow')
			}, delayMs)
		},
		onPointerLeave: (e: React.PointerEvent) => {
			if (e.pointerType === 'touch') return
			overTrigger.current = false
			hoverBlocked.current = false
			cancelOpen()
			if (mode === 'pinned') scheduleClose()
			else if (mode === 'follow') close()
		},
		onClick: (e: React.MouseEvent) => {
			const byTouch = lastPointerType.current === 'touch'
			if (mode === 'pinned') {
				hoverBlocked.current = !byTouch
				close()
				return
			}
			openedByKeyboard.current = false
			if (!pinnable && !byTouch) {
				hoverBlocked.current = true
				close()
				return
			}
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
		interactive: mode === 'pinned' && pinnable,
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
