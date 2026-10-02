import * as React from 'react'

import * as Flt from '@/lib/floating'

// A pinned tooltip sits a short gap away from the pointer, so moving onto it leaves both it and the trigger for a
// frame or two. A close waits this long for the pointer to arrive at the other one.
// How long a tip may outlive a trigger that hid under it. Nothing watches for `visibility: hidden`, so this polls.
const TRIGGER_GONE_POLL_MS = 200

const LEAVE_GRACE_MS = 150

// Once one tip has been read, a neighbouring one opens at once rather than making the reader wait again at every
// step along a row of buttons. Shared across every trigger, which is what makes a toolbar feel like one surface.
const SKIP_DELAY_MS = 300

// How long a help tip waits for the pointer to settle. Long enough that sweeping across a toolbar sets nothing
// off, short enough that stopping on a control still feels answered.
export const HELP_TIP_DELAY_MS = 300
let lastShownEndedAt = 0

type Mode = 'closed' | 'follow' | 'pinned'

type TriggerProps = {
	ref: (node: HTMLElement | null) => void
	'aria-describedby': string | undefined
	'aria-expanded'?: boolean
	onPointerDown: (e: React.PointerEvent) => void
	onPointerEnter: (e: React.PointerEvent) => void
	onPointerLeave: (e: React.PointerEvent) => void
	onClick: (e: React.MouseEvent) => void
	onFocus: () => void
	onBlur: () => void
}

type ContentProps = {
	id: string
	nodeRef: React.RefObject<HTMLDivElement | null>
	anchor: Flt.Point | null
	interactive: boolean
	onPointerEnter: (e: React.PointerEvent) => void
	onPointerLeave: (e: React.PointerEvent) => void
}

export type FollowTooltip = { open: boolean; pinned: boolean; triggerProps: TriggerProps; contentProps: ContentProps }

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
 *
 * Both options are read when the trigger mounts.
 */
export function useFollowTooltip(opts?: { pinnable?: boolean; delayMs?: number }): FollowTooltip {
	const id = React.useId()
	// The machine is a plain object rather than state and effects, so a closed tooltip costs three hooks and no
	// listeners: a settings page mounts several hundred and shows one at a time.
	const [machine] = React.useState(() => new FollowMachine(id, opts?.pinnable ?? true, opts?.delayMs ?? 0))
	React.useEffect(() => machine.attach(), [machine])
	return React.useSyncExternalStore(machine.subscribe, machine.getSnapshot)
}

class FollowMachine {
	private mode: Mode = 'closed'
	private anchor: Flt.Point | null = null
	private trigger: HTMLElement | null = null
	private readonly contentRef: React.RefObject<HTMLDivElement | null> = { current: null }
	private overTrigger = false
	private overContent = false
	private hoverBlocked = false
	private openedByKeyboard = false
	private lastPointerType = 'mouse'
	// a pointer press always lands before the focus it causes, so an unclaimed focus is a keyboard one
	private focusFromPointer = false
	private closeTimer: number | null = null
	private openTimer: number | null = null
	private pollTimer: number | null = null
	private listening: { keys: boolean; outside: boolean } = { keys: false, outside: false }
	private onChange: (() => void) | null = null
	private snapshot: FollowTooltip

	constructor(
		private readonly id: string,
		private readonly pinnable: boolean,
		private readonly delayMs: number,
	) {
		this.snapshot = this.buildSnapshot()
		// the tooltip node mounts only once open, and has to find the pointer for its first frame
		Flt.watchPointer()
	}

	subscribe = (onChange: () => void) => {
		this.onChange = onChange
		return () => {
			if (this.onChange === onChange) this.onChange = null
		}
	}

	getSnapshot = () => this.snapshot

	// returns the detach for an effect, so an effect re-run (strict mode, a hidden Activity) restores the listeners
	attach() {
		this.syncListeners()
		return () => {
			this.cancelClose()
			this.cancelOpen()
			if (this.mode !== 'closed') lastShownEndedAt = Date.now()
			this.syncListeners(true)
		}
	}

	private setState(mode: Mode, anchor: Flt.Point | null) {
		if (mode === this.mode && anchor === this.anchor) return
		// the moment it stopped being shown, which is what the next trigger's skip window is measured from
		if (mode !== this.mode && this.mode !== 'closed') lastShownEndedAt = Date.now()
		this.mode = mode
		this.anchor = anchor
		this.syncListeners()
		this.snapshot = this.buildSnapshot()
		this.onChange?.()
	}

	private buildSnapshot(): FollowTooltip {
		const mode = this.mode
		return {
			open: mode !== 'closed',
			pinned: mode === 'pinned',
			triggerProps: {
				ref: this.setTrigger,
				'aria-describedby': mode === 'closed' ? undefined : this.id,
				// only a pinnable trigger expands into something; a plain tooltip is described by its content, not disclosed
				'aria-expanded': this.pinnable ? mode === 'pinned' : undefined,
				onPointerDown: this.onTriggerPointerDown,
				onPointerEnter: this.onTriggerPointerEnter,
				onPointerLeave: this.onTriggerPointerLeave,
				onClick: this.onTriggerClick,
				onFocus: this.onTriggerFocus,
				onBlur: this.onTriggerBlur,
			},
			contentProps: {
				id: this.id,
				nodeRef: this.contentRef,
				anchor: this.anchor,
				interactive: mode === 'pinned' && this.pinnable,
				onPointerEnter: this.onContentPointerEnter,
				onPointerLeave: this.onContentPointerLeave,
			},
		}
	}

	// document listeners exist only while the tooltip is showing
	private syncListeners(detached = false) {
		const keys = !detached && this.mode !== 'closed'
		const outside = !detached && this.mode === 'pinned'
		if (keys !== this.listening.keys) {
			if (keys) {
				document.addEventListener('keydown', this.onDocumentKeyDown, true)
				this.pollTimer = window.setInterval(this.checkTriggerShown, TRIGGER_GONE_POLL_MS)
			} else {
				document.removeEventListener('keydown', this.onDocumentKeyDown, true)
				if (this.pollTimer !== null) window.clearInterval(this.pollTimer)
				this.pollTimer = null
			}
		}
		if (outside !== this.listening.outside) {
			if (outside) document.addEventListener('pointerdown', this.onDocumentPointerDown, true)
			else document.removeEventListener('pointerdown', this.onDocumentPointerDown, true)
		}
		this.listening = { keys, outside }
	}

	private onDocumentKeyDown = (ev: KeyboardEvent) => {
		if (ev.key === 'Escape') this.close()
	}

	private onDocumentPointerDown = (ev: PointerEvent) => {
		const target = ev.target as Node | null
		if (!target) return
		if (this.trigger?.contains(target) || this.contentRef.current?.contains(target)) return
		this.close()
	}

	private checkTriggerShown = () => {
		const node = this.trigger
		if (!node) return
		const shown =
			node.isConnected &&
			(node.checkVisibility ? node.checkVisibility({ visibilityProperty: true }) : getComputedStyle(node).visibility !== 'hidden')
		if (!shown) this.close()
	}

	// a callback ref rather than a ref object, so it attaches to a trigger of any element type
	private setTrigger = (node: HTMLElement | null) => {
		this.trigger = node
	}

	private cancelOpen() {
		if (this.openTimer === null) return
		window.clearTimeout(this.openTimer)
		this.openTimer = null
	}

	private cancelClose() {
		if (this.closeTimer === null) return
		window.clearTimeout(this.closeTimer)
		this.closeTimer = null
	}

	private close = () => {
		this.cancelClose()
		this.cancelOpen()
		this.openedByKeyboard = false
		this.setState('closed', null)
	}

	private scheduleClose() {
		this.cancelClose()
		this.closeTimer = window.setTimeout(() => {
			this.closeTimer = null
			if (this.overTrigger || this.overContent) return
			this.close()
		}, LEAVE_GRACE_MS)
	}

	private pin(at: Flt.Point | null) {
		this.cancelClose()
		this.cancelOpen()
		this.setState('pinned', at ?? triggerCorner(this.trigger))
	}

	private onTriggerPointerDown = (e: React.PointerEvent) => {
		this.lastPointerType = e.pointerType
		this.focusFromPointer = true
	}

	private onTriggerPointerEnter = (e: React.PointerEvent) => {
		if (e.pointerType === 'touch') return
		this.overTrigger = true
		this.cancelClose()
		if (this.mode !== 'closed' || this.hoverBlocked || this.openTimer !== null) return
		if (this.delayMs === 0 || Date.now() - lastShownEndedAt < SKIP_DELAY_MS) {
			this.setState('follow', this.anchor)
			return
		}
		this.openTimer = window.setTimeout(() => {
			this.openTimer = null
			if (this.overTrigger) this.setState('follow', this.anchor)
		}, this.delayMs)
	}

	private onTriggerPointerLeave = (e: React.PointerEvent) => {
		if (e.pointerType === 'touch') return
		this.overTrigger = false
		this.hoverBlocked = false
		this.cancelOpen()
		if (this.mode === 'pinned') this.scheduleClose()
		else if (this.mode === 'follow') this.close()
	}

	private onTriggerClick = (e: React.MouseEvent) => {
		const byTouch = this.lastPointerType === 'touch'
		if (this.mode === 'pinned') {
			this.hoverBlocked = !byTouch
			this.close()
			return
		}
		this.openedByKeyboard = false
		if (!this.pinnable && !byTouch) {
			this.hoverBlocked = true
			this.close()
			return
		}
		// a keyboard-triggered click reports no coordinates, so fall back to the trigger itself
		this.pin(e.detail === 0 ? null : { x: e.clientX, y: e.clientY })
	}

	private onTriggerFocus = () => {
		const byPointer = this.focusFromPointer
		this.focusFromPointer = false
		if (byPointer || this.mode !== 'closed') return
		this.openedByKeyboard = true
		this.pin(null)
	}

	private onTriggerBlur = () => {
		this.focusFromPointer = false
		if (this.openedByKeyboard) this.close()
	}

	private onContentPointerEnter = (e: React.PointerEvent) => {
		if (e.pointerType === 'touch') return
		this.overContent = true
		this.cancelClose()
	}

	private onContentPointerLeave = (e: React.PointerEvent) => {
		if (e.pointerType === 'touch') return
		this.overContent = false
		this.scheduleClose()
	}
}

function triggerCorner(el: HTMLElement | null): Flt.Point | null {
	if (!el) return null
	const rect = el.getBoundingClientRect()
	return { x: Flt.documentIsRtl() ? rect.right : rect.left, y: rect.bottom }
}
