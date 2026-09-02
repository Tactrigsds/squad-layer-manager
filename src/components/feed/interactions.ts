// The interactions a dom-built row offers, delegated.
//
// A feed row carries no listeners of its own. One set of handlers on the document reads the payload off whichever
// element was hit and the ambient state off the enclosing scope (see render-context), which is what makes the cost
// of a row independent of how many of them there are: the 628-row feed has one context menu and one tooltip behind
// it rather than 803 and 628.

import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Zus from '@/lib/zustand'
import * as HistoryMsgs from '@/messages/history.messages'
import { DraggableWindowStore } from '@/systems/draggable-window.client'
import { tr } from '@/systems/messages.client'

import { formatFullTime } from './format'
import * as RC from './render-context'

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
	menu: { target: RC.MenuTarget; stores: SquadServerFrame.KeyProp | undefined; zIndexBase: number } | null
	tip: { content: RC.TipContent; rect: DOMRect; zIndexBase: number } | null
	tipOpen: boolean
}

export const OverlayStore = Zus.createStore<OverlayState>(() => ({ menu: null, tip: null, tipOpen: false }))

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
	const element = elementAt(event, RC.MENU_ATTR)
	if (!element || !menuAnchor) return
	const target = RC.menuTargetOf(element)
	const ctx = RC.scopeOf(element)
	const stores = storesAt(element)
	// a squad only exists on a server, so its menu has nothing to say without one
	if (!target || !ctx || (target.kind === 'squad' && !stores)) return
	event.preventDefault()
	OverlayStore.setState({ menu: { target, stores, zIndexBase: ctx.zIndexBase } })
	// radix's own trigger is what knows how to place and open the menu, and all it reads off the event is the
	// point. Re-firing at the parked trigger gets its placement, its focus handling and its dismissal for free.
	menuAnchor.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: event.clientX, clientY: event.clientY }))
}

// -------- tooltip --------

function tipContentOf(element: Element): RC.TipContent | null {
	const time = element.getAttribute(RC.TIP_TIME_ATTR)
	// deliberately not formatted until now: a timezone-qualified timestamp per row is most of what a feed's
	// timestamps cost, and only the one being hovered is ever read
	if (time !== null) return { text: formatFullTime(Number(time)) }
	const text = element.getAttribute(RC.TIP_ATTR)
	if (text === null) return null
	return { text, heading: element.getAttribute(RC.TIP_HEADING_ATTR) ?? undefined }
}

let tipElement: Element | null = null

export function closeTip() {
	tipElement = null
	if (OverlayStore.getState().tipOpen) OverlayStore.setState({ tipOpen: false })
}

function showTip(element: Element) {
	if (element === tipElement) return
	const content = tipContentOf(element)
	if (!content) return
	tipElement = element
	const zIndexBase = RC.scopeOf(element)?.zIndexBase ?? 0
	OverlayStore.setState({ tip: { content, rect: element.getBoundingClientRect(), zIndexBase }, tipOpen: true })
}

const TIP_SELECTOR = `[${RC.TIP_ATTR}],[${RC.TIP_TIME_ATTR}]`

function tipTargetOf(event: Event) {
	const target = event.target
	return target instanceof Element ? target.closest(TIP_SELECTOR) : null
}

function onPointerOver(event: PointerEvent) {
	const tip = tipTargetOf(event)
	if (tip) showTip(tip)
	else closeTip()

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
	const tip = tipTargetOf(event)
	if (tip) showTip(tip)
	else closeTip()
}

// focus leaving for nothing in particular fires no focusin, so the tooltip would otherwise stay behind
function onFocusOut(event: FocusEvent) {
	if (tipTargetOf(event) === tipElement) closeTip()
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
	document.addEventListener('scroll', onScroll, { capture: true, passive: true })
}
