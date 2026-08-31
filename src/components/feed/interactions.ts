// The interactions a dom-built row offers, delegated.
//
// A feed row carries no listeners of its own. One set of handlers on the document reads the payload off whichever
// element was hit and the ambient state off the enclosing scope (see render-context), which is what makes the cost
// of a row independent of how many of them there are: the 628-row feed has one context menu and one tooltip behind
// it rather than 803 and 628.

import * as SquadServerFrame from '@/frames/squad-server.frame'
import * as Zus from '@/lib/zustand'
import { DraggableWindowStore } from '@/systems/draggable-window.client'

import * as Atoms from './atoms'
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
	menu: { target: RC.MenuTarget; stores: SquadServerFrame.KeyProp; zIndexBase: number } | null
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
	const element = elementAt(event, RC.WINDOW_ATTR)
	if (!element) return
	const target = RC.windowTargetOf(element)
	if (!target) return
	const props = windowProps(element, target)
	if (!props) return
	DraggableWindowStore.getState().openWindow(target.windowId, props, element as HTMLElement, outletOf(element))
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
	// the menu's options all act on a server frame, so no frame means the browser's own menu
	if (!target || !ctx || !stores) return
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
	if (time !== null) return { text: Atoms.formatFullTime(Number(time)) }
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
