// The interactions a dom-built row offers, delegated.
//
// A feed row carries no listeners of its own. One set of handlers on the document reads the payload off whichever
// element was hit and the ambient state off the enclosing scope (see render-context), which is what makes the cost
// of a row independent of how many of them there are: the 628-row feed has one context menu and one tooltip behind
// it rather than 803 and 628.

import * as SquadServerFrame from '@/frames/squad-server.frame'
import type * as Flt from '@/lib/floating'
import * as Zus from '@/lib/zustand'
import * as HistoryMsgs from '@/messages/history.messages'
import * as SM_Msgs from '@/messages/squad.messages'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import { tr } from '@/systems/messages.client'

import { formatFullTime } from './format'
import * as RC from './render-context'
import * as Selection from './selection'

// the windows a row can open, registered before any click can ask for one. Loaded here rather than in the
// (isomorphic) builders: registration only means anything where windows exist.
void import('@/components/player-details-window')
void import('@/components/squad-details-window')
void import('@/components/layer-info')

const INTENT_DELAY = 150

// Both payloads outlive their overlay closing: radix keeps content mounted through the exit animation, and an
// overlay whose content went blank halfway through the fade reads as a glitch.
type OverlayState = {
	// stores are absent where the scope has no frame to offer, which the menu's own options answer for: the
	// layer target never wanted one, and a player's menu falls back to what is true off any server
	menu: { target: RC.MenuTarget | TimeMenuTarget; stores: SquadServerFrame.KeyProp | undefined; zIndexBase: number } | null
	tip: { content: RC.TipContent; zIndexBase: number } | null
	tipOpen: boolean
	// where a pinned tooltip is parked. Null means it follows the pointer, which also means the pointer
	// cannot reach it (see the tooltip section).
	tipAnchor: Flt.Point | null
}

// A row's timestamp. Built when the menu opens rather than read off attributes, since what it offers depends on
// the selection at that moment: the link and the text cover the selection when the row is part of it, and the
// row alone otherwise.
export type TimeMenuTarget = {
	kind: 'time'
	time: number
	// absent outside a selectable feed. `selection` is the row alone when it is not part of the host's own.
	rows?: { hostKey: string; selection: RC.RowSelection; wholeSelection: boolean }
	link?: { url: string; caveat?: string }
}

export const OverlayStore = Zus.createStore<OverlayState>(() => ({ menu: null, tip: null, tipOpen: false, tipAnchor: null }))

// The hidden trigger the overlay host parks for the context menu. Radix positions and opens a menu from its own
// trigger, so rather than reimplement any of that, this one is re-fired at whatever the pointer is actually on
// (see dom-overlays.tsx). The tooltip needs no equivalent: its trigger is placed from the stored rect.
let menuAnchor: HTMLElement | null = null

export function setMenuAnchor(node: HTMLElement | null) {
	menuAnchor = node
}

// a row that isn't inside a registered scope opens into the page's own window outlet, which is where a window
// belongs unless something has said otherwise
function outletOf(element: Element) {
	return RC.scopeOf(element)?.outletKey ?? 'default'
}

function elementAt(event: Event, attr: string) {
	const target = event.target
	return target instanceof Element ? target.closest(`[${attr}]`) : null
}

// -------- windows --------

let intentElement: Element | null = null
let intentTimer: ReturnType<typeof setTimeout> | null = null

function clearIntent() {
	if (intentTimer !== null) clearTimeout(intentTimer)
	intentTimer = null
	intentElement = null
}

// The squad-server frame behind an element, resolved from its scope: per-match on scopes whose rows span
// servers (the history page), else the scope's own. Undefined when the scope has none to offer.
function storesAt(element: Element): SquadServerFrame.KeyProp | undefined {
	const scope = RC.scopeOf(element)
	if (!scope) return undefined
	const perMatch = scope.storesForMatch?.(RC.matchIdOf(element))
	if (perMatch) return perMatch
	return scope.stores.squadServer ? scope.stores : undefined
}

// the props a window target opens with: its serialized arg, plus the scope's frame per the target's mode
function windowProps(element: Element, target: RC.WindowTarget): Record<string, unknown> | undefined {
	if (!target.frame) return target.arg
	const stores = storesAt(element)
	if (stores) return { ...target.arg, stores }
	return target.frame === 'require' ? undefined : target.arg
}

function onClick(event: MouseEvent) {
	// the tooltip first: its trigger sits inside a row, and pinning it must not also open whatever the row does
	const tip = tipTargetOf(event)
	if (pinnedElement && !withinPinned(event.target)) closeTip()
	if (tip) {
		// a second click on the trigger dismisses, the same way the constraint indicators behave
		if (pinnedElement === tip) closeTip()
		else if (isInteractive(tipContentOf(tip, RC.scopeOf(tip)) ?? undefined)) pinTip(tip, { x: event.clientX, y: event.clientY })
		return
	}

	// "load more" before the row itself, since the button sits inside the row's own panel
	const more = elementAt(event, RC.ROW_EVENTS_MORE_ATTR)
	if (more) {
		const row = more.closest(`[${RC.ROW_EVENTS_ATTR}]`) ?? more.closest('tbody')?.querySelector(`[${RC.ROW_EVENTS_ATTR}]`)
		const panel = more.closest(`[${RC.ROW_EVENTS_PANEL_ATTR}]`)
		const owner = panel?.previousElementSibling
		if (owner?.hasAttribute(RC.ROW_EVENTS_ATTR)) fillRowEvents(owner, true)
		else if (row) fillRowEvents(row, true)
		return
	}
	const copy = elementAt(event, RC.COPY_ATTR)
	if (copy) {
		const id = copy.getAttribute(RC.COPY_ATTR)
		if (id) {
			void navigator.clipboard.writeText(id)
			showCopied(copy, { x: event.clientX, y: event.clientY })
		}
		return
	}

	// The opener before the row: a results row carries its key on the whole <tr>, so every target inside one
	// -- a layer name, a player name -- is also inside the disclosure, and taking the row first meant those
	// only ever expanded it.
	const element = elementAt(event, RC.WINDOW_ATTR)
	const target = element && RC.windowTargetOf(element)
	const props = element && target && windowProps(element, target)
	if (element && target && props) {
		DraggableWindowStore.getState().openWindow(target.windowId, props, element as HTMLElement, outletOf(element))
		return
	}

	const rowEvents = elementAt(event, RC.ROW_EVENTS_ATTR)
	if (rowEvents) toggleRowEvents(rowEvents)
}

// shift-clicking an admin badge selects every admin on that player's team; ctrl too, and it selects both sides
function onClickCapture(event: MouseEvent) {
	if (!event.shiftKey) return
	const element = elementAt(event, RC.ADMIN_BADGE_ATTR)
	const badge = element && RC.adminBadgeOf(element)
	if (!badge) return
	const stores = storesAt(element)
	if (!stores) return
	event.preventDefault()
	event.stopPropagation()
	SquadServerFrame.Actions.selectAllAdmins(stores, event.ctrlKey ? undefined : (badge.teamId ?? undefined))
}

// -------- context menu --------

function onContextMenu(event: MouseEvent) {
	// a selectable feed's gutter first, which covers more than its timestamps do; a timestamp anywhere else is
	// only its own element
	const time = gutterAt(event)?.time ?? elementAt(event, RC.TIP_TIME_ATTR)
	if (time && menuAnchor) {
		event.preventDefault()
		openMenu({ target: timeMenuTarget(time), stores: undefined, zIndexBase: RC.scopeOf(time)?.zIndexBase ?? 0 }, event)
		return
	}
	const element = elementAt(event, RC.MENU_ATTR)
	if (!element || !menuAnchor) return
	const target = RC.menuTargetOf(element)
	const ctx = RC.scopeOf(element)
	const stores = storesAt(element)
	// a squad only exists on a server, so its menu has nothing to say without one
	if (!target || !ctx || (target.kind === 'squad' && !stores)) return
	event.preventDefault()
	openMenu({ target, stores, zIndexBase: ctx.zIndexBase }, event)
}

function openMenu(menu: NonNullable<OverlayState['menu']>, event: MouseEvent) {
	OverlayStore.setState({ menu })
	// radix's own trigger is what knows how to place and open the menu, and all it reads off the event is the
	// point. Re-firing at the parked trigger gets its placement, its focus handling and its dismissal for free.
	menuAnchor!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: event.clientX, clientY: event.clientY }))
}

function timeMenuTarget(timeElement: Element): TimeMenuTarget {
	const target: TimeMenuTarget = { kind: 'time', time: Number(timeElement.getAttribute(RC.TIP_TIME_ATTR)) }
	const host = timeElement.closest(`[${RC.SELECTABLE_ATTR}]`)
	const row = host && Selection.rowOf(host, timeElement)
	const hostKey = host && Selection.keyOf(host)
	if (!host || !row || !hostKey) return target
	const selection = Selection.get(hostKey)
	const wholeSelection = Selection.contains(host, selection, row)
	const rowId = row.getAttribute(RC.ROW_ATTR)!
	const covered = wholeSelection ? selection! : { anchor: rowId, head: rowId }
	target.rows = { hostKey, selection: covered, wholeSelection }
	const rows = wholeSelection ? Selection.selectedRows(host, selection) : [row]
	target.link = RC.scopeOf(host)?.linkToRows?.(covered, rows, Selection.groupOf(host))
	return target
}

// -------- row selection --------
//
// Dragged from a row's time gutter (see Selection.gutterAt), the way a code view's line numbers work, so that
// pressing anywhere else in a row still selects its text. A click selects the one row, or clears it when it was
// the whole selection, and shift extends from the anchor.

function gutterAt(event: MouseEvent) {
	const target = event.target instanceof Element ? event.target : null
	const host = target && Selection.hostAt(target)
	const hit = host && Selection.gutterAt(host, event.clientX, event.clientY)
	return hit ? { host: host!, ...hit } : null
}

// the pointer cursor over the gutter, which has no element of its own to carry it
let gutterCursor = false

function setGutterCursor(on: boolean) {
	if (on === gutterCursor) return
	gutterCursor = on
	document.documentElement.style.cursor = on ? 'pointer' : ''
}

type Drag = {
	host: Element
	hostKey: string
	anchor: string
	head: string
	moved: boolean
	pointer: Flt.Point
	scroller: Element | null
	frame: number | null
}

let drag: Drag | null = null
// the host a selection was last made in, which is what escape and copy act on
let activeHostKey: string | null = null

const AUTOSCROLL_EDGE = 32
const AUTOSCROLL_MAX_STEP = 16

function onPointerDown(event: PointerEvent) {
	if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return
	const hit = gutterAt(event)
	const hostKey = hit && Selection.keyOf(hit.host)
	if (!hit || !hostKey) return
	const { host, row } = hit
	// No text selection and no focus ring from pressing the time's button. That also keeps focus where it
	// was, so it is let go by hand: an input still holding it would take the copy and escape meant for rows.
	event.preventDefault()
	if (document.activeElement instanceof HTMLElement && isEditable(document.activeElement)) document.activeElement.blur()
	const rowId = row.getAttribute(RC.ROW_ATTR)!
	const existing = Selection.get(hostKey)
	drag = {
		host,
		hostKey,
		anchor: event.shiftKey && existing ? existing.anchor : rowId,
		head: rowId,
		moved: event.shiftKey,
		pointer: { x: event.clientX, y: event.clientY },
		scroller: Selection.scrollParentOf(host),
		frame: null,
	}
	activeHostKey = hostKey
	Selection.paint(host, { anchor: drag.anchor, head: drag.head })
	if (event.pointerType === 'mouse') drag.frame = requestAnimationFrame(autoscroll)
}

function onPointerMove(event: PointerEvent) {
	if (!drag) {
		if (event.pointerType === 'mouse') setGutterCursor(gutterAt(event) !== null)
		return
	}
	drag.pointer = { x: event.clientX, y: event.clientY }
	extendTo(drag.pointer)
}

// by height alone, so the pointer can wander sideways off the rows, or past either end of them, mid-drag
function extendTo(point: Flt.Point) {
	if (!drag) return
	// held inside the scroller's view: past its edge are rows it is clipping, which autoscroll brings in
	let y = point.y
	if (drag.scroller) {
		const view = Selection.viewOf(drag.scroller)
		y = Math.min(Math.max(y, view.top + 1), view.bottom - 1)
	}
	const row = Selection.rowAtY(drag.host, y, true)
	const id = row?.getAttribute(RC.ROW_ATTR)
	if (!id || id === drag.head) return
	drag.head = id
	drag.moved = true
	Selection.paint(drag.host, { anchor: drag.anchor, head: drag.head })
}

// Scrolls the feed while the pointer is held past its top or bottom edge, faster the further past it is. Per
// frame rather than per move, so a pointer held still at the edge keeps scrolling.
function autoscroll() {
	if (!drag) return
	drag.frame = requestAnimationFrame(autoscroll)
	const scroller = drag.scroller
	if (!scroller) return
	const rect = Selection.viewOf(scroller)
	const y = drag.pointer.y
	let step = 0
	if (y < rect.top + AUTOSCROLL_EDGE) step = -Math.min(AUTOSCROLL_MAX_STEP, rect.top + AUTOSCROLL_EDGE - y)
	else if (y > rect.bottom - AUTOSCROLL_EDGE) step = Math.min(AUTOSCROLL_MAX_STEP, y - (rect.bottom - AUTOSCROLL_EDGE))
	if (step === 0) return
	scroller.scrollTop += step
	extendTo(drag.pointer)
}

function onPointerUp() {
	if (!drag) return
	const { hostKey, anchor, head, moved, frame } = drag
	if (frame !== null) cancelAnimationFrame(frame)
	drag = null
	const existing = Selection.get(hostKey)
	const alone = existing?.anchor === anchor && existing.head === anchor
	Selection.set(hostKey, !moved && alone ? undefined : { anchor, head })
}

// a touch that turned into a scroll is not a selection
function onPointerCancel() {
	if (!drag) return
	if (drag.frame !== null) cancelAnimationFrame(drag.frame)
	const { host, hostKey } = drag
	drag = null
	Selection.paint(host, Selection.get(hostKey))
}

function isEditable(target: EventTarget | null) {
	return target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null)
}

function onSelectionKeyDown(event: KeyboardEvent) {
	if (!activeHostKey || isEditable(event.target)) return
	const selection = Selection.get(activeHostKey)
	if (!selection) return
	// escape belongs to whatever overlay has it first
	const inOverlay = event.target instanceof Element && event.target.closest('[role="menu"],[role="dialog"]') !== null
	if (event.key === 'Escape' && !pinnedElement && !inOverlay) {
		Selection.set(activeHostKey, undefined)
		return
	}
	if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
		// a text selection is the reader's own, and copies the ordinary way
		if (!(window.getSelection()?.isCollapsed ?? true)) return
		const host = Selection.hostOf(activeHostKey)
		if (!host || !RC.scopeOf(host)?.selectionText) return
		event.preventDefault()
		Selection.copySelection(host, selection)
	}
}

// -------- tooltip --------
//
// Follows the pointer and opens with no delay, the same behaviour the constraint indicators have (see
// TrackingTooltip). Clicking a trigger pins the tooltip where the pointer is and lets the pointer reach it,
// which is the only way to use content with a link in it: the match tooltip's is how its layer opens.

function tipContentOf(element: Element, ctx: RC.RenderCtx | undefined): RC.TipContent | null {
	const matchId = element.getAttribute(RC.TIP_MATCH_ATTR)
	// looked up rather than carried: the page that rendered these rows was handed their matches too, so the
	// alternative is a copy of the same summary on every row of the match
	if (matchId !== null) {
		const details = ctx?.matchById(Number(matchId))
		return details ? { kind: 'match', details } : null
	}
	const time = element.getAttribute(RC.TIP_TIME_ATTR)
	// deliberately not formatted until now: a timezone-qualified timestamp per row is most of what a feed's
	// timestamps cost, and only the one being hovered is ever read
	if (time !== null) return { kind: 'text', text: formatFullTime(Number(time)) }
	const text = element.getAttribute(RC.TIP_ATTR)
	if (text === null) return null
	return { kind: 'text', text, heading: element.getAttribute(RC.TIP_HEADING_ATTR) ?? undefined }
}

let tipElement: Element | null = null
// the trigger of a pinned tooltip, which hovering elsewhere no longer replaces
let pinnedElement: Element | null = null
let leaveTimer: ReturnType<typeof setTimeout> | null = null
// the pinned tooltip's own node, so the handlers can tell "the pointer is inside it" from "the pointer left"
let tipContentNode: HTMLElement | null = null

export function setTipContentNode(node: HTMLElement | null) {
	tipContentNode = node
}

function cancelLeave() {
	if (leaveTimer === null) return
	clearTimeout(leaveTimer)
	leaveTimer = null
}

export function closeTip() {
	cancelLeave()
	clearCopied()
	tipElement = null
	pinnedElement = null
	if (OverlayStore.getState().tipOpen) OverlayStore.setState({ tipOpen: false, tipAnchor: null })
}

function showTip(element: Element) {
	// a real tooltip supersedes the copy feedback, and the feedback's timer must not take it down with it
	clearCopied()
	if (element === tipElement) return
	const ctx = RC.scopeOf(element)
	const content = tipContentOf(element, ctx)
	if (!content) return
	tipElement = element
	OverlayStore.setState({ tip: { content, zIndexBase: ctx?.zIndexBase ?? 0 }, tipOpen: true, tipAnchor: null })
}

// the "Copied!" feedback, through the same overlay a tooltip uses: parked at the click and gone shortly after
let copiedTimer: ReturnType<typeof setTimeout> | null = null

function clearCopied() {
	if (copiedTimer === null) return
	clearTimeout(copiedTimer)
	copiedTimer = null
}

function showCopied(element: Element, at: Flt.Point) {
	closeTip()
	tipElement = element
	OverlayStore.setState({
		tip: { content: { kind: 'text', text: tr.text(SM_Msgs.copiedFeedback()) }, zIndexBase: RC.scopeOf(element)?.zIndexBase ?? 0 },
		tipOpen: true,
		tipAnchor: at,
	})
	copiedTimer = setTimeout(closeTip, 1500)
}

// A pinned tooltip sits a short gap from the pointer, so moving onto it leaves both it and the trigger for a
// frame or two. Same grace as useFollowTooltip, for the same reason.
const LEAVE_GRACE_MS = 150

function pinTip(element: Element, at: Flt.Point) {
	showTip(element)
	if (!OverlayStore.getState().tipOpen) return
	cancelLeave()
	pinnedElement = element
	OverlayStore.setState({ tipAnchor: at })
}

// whether the tooltip's content can be clicked, which is what makes pinning it worth offering
function isInteractive(content: RC.TipContent | undefined) {
	return content?.kind === 'match'
}

const TIP_SELECTOR = `[${RC.TIP_ATTR}],[${RC.TIP_TIME_ATTR}],[${RC.TIP_MATCH_ATTR}]`

function tipTargetOf(event: Event) {
	const target = event.target
	return target instanceof Element ? target.closest(TIP_SELECTOR) : null
}

function withinPinned(target: EventTarget | null) {
	if (!(target instanceof Node)) return false
	return !!tipContentNode?.contains(target) || !!pinnedElement?.contains(target)
}

function onPointerOver(event: PointerEvent) {
	const tip = tipTargetOf(event)
	if (pinnedElement) {
		// nothing else opens while one is pinned; it closes by leaving it, by pressing outside, or by escape
		if (withinPinned(event.target)) cancelLeave()
		else if (leaveTimer === null) leaveTimer = setTimeout(closeTip, LEAVE_GRACE_MS)
	} else if (tip) showTip(tip)
	// the copy feedback rides out pointer movement and leaves on its own timer
	else if (copiedTimer === null) closeTip()

	const rowEvents = elementAt(event, RC.ROW_EVENTS_ATTR)
	if (rowEvents) fillRowEvents(rowEvents)

	const opener = elementAt(event, RC.WINDOW_ATTR)
	if (opener === intentElement) return
	clearIntent()
	const openerTarget = opener ? RC.windowTargetOf(opener) : undefined
	if (!opener || !openerTarget?.preload || !windowProps(opener, openerTarget)) return
	intentElement = opener
	intentTimer = setTimeout(() => {
		const target = RC.windowTargetOf(opener)
		const props = target && windowProps(opener, target)
		if (target && props) DraggableWindowStore.getState().preloadWindow(target.windowId, props, outletOf(opener))
		clearIntent()
	}, INTENT_DELAY)
}

// -------- a results row's own events --------

function panelOf(row: Element) {
	const next = row.nextElementSibling
	return next?.hasAttribute(RC.ROW_EVENTS_PANEL_ATTR) ? next : null
}

/**
 * Fetches one page of a row's events into its panel.
 *
 * Driven by hover as well as by opening the row, so the first page is usually already there by the time it
 * is opened. Idempotent for that first page: whichever fires first claims the row, and the other finds it
 * claimed. `more` resumes from the cursor the last page left behind.
 */
function fillRowEvents(row: Element, more = false) {
	if (!more && row.hasAttribute(RC.ROW_EVENTS_DONE_ATTR)) return
	const key = row.getAttribute(RC.ROW_EVENTS_ATTR)
	const slot = panelOf(row)?.querySelector(`[${RC.ROW_EVENTS_SLOT_ATTR}]`)
	const ctx = RC.scopeOf(row)
	if (!key || !slot || !ctx?.loadRowEvents) return

	const parked = row.getAttribute(RC.ROW_EVENTS_CURSOR_ATTR)
	if (more && !parked) return
	// claimed before the await, so a second hover during the fetch does not start another
	row.setAttribute(RC.ROW_EVENTS_DONE_ATTR, '')
	row.removeAttribute(RC.ROW_EVENTS_CURSOR_ATTR)
	const cursor = more && parked ? (JSON.parse(parked) as unknown) : undefined
	slot.querySelector(`[${RC.ROW_EVENTS_MORE_ATTR}]`)?.remove()
	// a row opened before its hover finished, or opened without one at all (touch, keyboard), would otherwise
	// show an empty tray for as long as the fetch takes
	setStatus(slot, tr.text(HistoryMsgs.eventsLoading()))

	void ctx
		.loadRowEvents(key, cursor)
		.then((page) => {
			setStatus(slot, null)
			slot.insertAdjacentHTML('beforeend', page.rows.join(''))
			Selection.adoptRowEvents(slot, ctx.scopeId, key)
			Selection.paint(slot)
			if (page.nextCursor === undefined) return
			row.setAttribute(RC.ROW_EVENTS_CURSOR_ATTR, JSON.stringify(page.nextCursor))
			const button = document.createElement('button')
			button.type = 'button'
			button.setAttribute(RC.ROW_EVENTS_MORE_ATTR, '')
			button.className = 'self-start px-1 py-0.5 text-xs text-muted-foreground hover:text-foreground'
			button.textContent = tr.text(HistoryMsgs.loadMore())
			slot.append(button)
		})
		.catch(() => {
			// says so rather than leaving the tray blank, and lets another open retry
			setStatus(slot, tr.text(HistoryMsgs.eventsFailed()))
			row.removeAttribute(RC.ROW_EVENTS_DONE_ATTR)
		})
}

// one status line per slot, replaced or cleared in place, so it never stacks up over several pages
function setStatus(slot: Element, text: string | null) {
	let line = slot.querySelector(`[${RC.ROW_EVENTS_STATUS_ATTR}]`)
	if (text === null) {
		line?.remove()
		return
	}
	if (!line) {
		line = document.createElement('div')
		line.setAttribute(RC.ROW_EVENTS_STATUS_ATTR, '')
		line.className = 'px-1 py-0.5 text-xs text-muted-foreground'
		slot.append(line)
	}
	line.textContent = text
}

function toggleRowEvents(row: Element) {
	const panel = panelOf(row)
	if (!panel) return
	const opening = panel.hasAttribute('hidden')
	if (opening) {
		panel.removeAttribute('hidden')
		row.setAttribute(RC.ROW_OPEN_ATTR, '')
		fillRowEvents(row)
	} else {
		panel.setAttribute('hidden', '')
		row.removeAttribute(RC.ROW_OPEN_ATTR)
	}
}

function onFocusIn(event: FocusEvent) {
	if (pinnedElement) return
	const tip = tipTargetOf(event)
	if (tip) showTip(tip)
	else closeTip()
}

// focus leaving for nothing in particular fires no focusin, so the tooltip would otherwise stay behind
function onFocusOut(event: FocusEvent) {
	if (!pinnedElement && tipTargetOf(event) === tipElement) closeTip()
}

function onKeyDown(event: KeyboardEvent) {
	if (event.key === 'Escape' && pinnedElement) closeTip()
}

// the anchor holds a rect captured at hover time, so a feed that scrolls out from under it would leave the tooltip
// pointing at nothing
function onScroll() {
	closeTip()
}

let installed = false

export function setup() {
	if (installed) return
	installed = true
	document.addEventListener('click', onClickCapture, true)
	document.addEventListener('click', onClick)
	document.addEventListener('contextmenu', onContextMenu)
	document.addEventListener('pointerover', onPointerOver)
	document.addEventListener('focusin', onFocusIn)
	document.addEventListener('focusout', onFocusOut)
	document.addEventListener('keydown', onKeyDown, true)
	document.addEventListener('keydown', onSelectionKeyDown)
	document.addEventListener('pointerdown', onPointerDown)
	document.addEventListener('pointermove', onPointerMove, { passive: true })
	document.addEventListener('pointerup', onPointerUp)
	document.addEventListener('pointercancel', onPointerCancel)
	document.addEventListener('scroll', onScroll, { capture: true, passive: true })
}
