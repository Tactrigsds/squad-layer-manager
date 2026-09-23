// A highlighted run of feed rows, one per scope.
//
// The rows are plain dom (see render-context), so the selection is painted onto them as an attribute rather than
// rendered. It is held by event id, so a host re-paints it after inserting or rebuilding rows, and an end that is
// not loaded yet paints nothing until it is.

import { toast } from '@/lib/toast'
import * as Zus from '@/lib/zustand'
import * as CHAT_Msgs from '@/messages/chat.messages'
import { tr } from '@/systems/messages.client'

import * as RC from './render-context'

/**
 * For a selectable host: how its selected rows, and the timestamps a selection is dragged from, look. Every row is
 * inset by the selection's edge, selected or not, so selecting never shifts the text.
 */
export const HOST_CLASS = '[&>*]:pl-1.5 [&>[data-selected]]:bg-info/15 [&>[data-selected]]:shadow-[inset_2px_0_0_var(--color-info)]'

// Keyed by host (see RC.SELECTABLE_ATTR): a feed's own scope id, or for the events under a results row, the scope
// and that row's key.
type State = { byHost: Record<string, RC.RowSelection | undefined> }

export const SelectionStore = Zus.createStore<State>(() => ({ byHost: {} }))

export function get(hostKey: string): RC.RowSelection | undefined {
	return SelectionStore.getState().byHost[hostKey]
}

export function set(hostKey: string, selection: RC.RowSelection | undefined) {
	const prev = get(hostKey)
	if (prev?.anchor === selection?.anchor && prev?.head === selection?.head) return
	SelectionStore.setState((s) => ({ byHost: { ...s.byHost, [hostKey]: selection } }))
	const host = hostOf(hostKey)
	if (host) paint(host, selection)
}

/** What makes an element a feed's selectable host, for a feed whose rows react renders (see ServerEvent). */
export function hostAttrs(scopeId: string): RC.Attrs {
	return { [RC.SCOPE_ATTR]: scopeId, [RC.SELECTABLE_ATTR]: scopeId }
}

export function hostOf(hostKey: string): Element | null {
	return document.querySelector(`[${RC.SELECTABLE_ATTR}="${CSS.escape(hostKey)}"]`)
}

export function keyOf(host: Element): string | null {
	return host.getAttribute(RC.SELECTABLE_ATTR) || null
}

/**
 * The results row a host's events belong to, by its key (`player:<id>`, `match:<id>`), when the host is the events
 * under one; undefined for a feed of its own. What a selection there has to be narrowed by to name the same events.
 */
export function groupOf(host: Element): string | undefined {
	return host.closest(`[${RC.ROW_EVENTS_PANEL_ATTR}]`)?.getAttribute(RC.ROW_EVENTS_PANEL_ATTR) ?? undefined
}

/** Makes the events under a results row selectable, once its first page is in. */
export function adoptRowEvents(slot: Element, scopeId: string, rowKey: string) {
	if (slot.hasAttribute(RC.SELECTABLE_ATTR)) return
	slot.setAttribute(RC.SELECTABLE_ATTR, `${scopeId}/${rowKey}`)
	slot.classList.add(...HOST_CLASS.split(' '))
}

// -------- the gutter --------
//
// A drag starts, and the timestamp menu opens, anywhere in a row's time gutter: from the row's left edge to the
// right edge of its timestamp, over the row's full height. Hit-tested by position rather than by the element under
// the pointer, since a row's padding and the gaps between rows belong to no timestamp, and a press there would
// otherwise miss.

/** The selectable host an event target is in, or whose rows it sits between (a gap in the rows' container). */
export function hostAt(target: Element): Element | null {
	return target.closest(`[${RC.SELECTABLE_ATTR}]`) ?? target.querySelector(`:scope > [${RC.SELECTABLE_ATTR}]`)
}

/**
 * The row at viewport height `y`. A gap between two rows belongs to the one above it. `clamp` answers the first or
 * last row for a point above or below them all, which is what a drag past either end wants.
 */
export function rowAtY(host: Element, y: number, clamp = false): Element | null {
	const rows = host.children
	if (rows.length === 0) return null
	// the last row whose top is at or above y, by binary search: only a handful of rects read per call
	let lo = 0
	let hi = rows.length - 1
	let found = -1
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		if (rows[mid].getBoundingClientRect().top <= y) {
			found = mid
			lo = mid + 1
		} else hi = mid - 1
	}
	if (found < 0) return clamp ? rowIn(rows[0]) : null
	const row = rows[found]
	if (!clamp && found === rows.length - 1 && y > row.getBoundingClientRect().bottom) return null
	return rowIn(row)
}

function rowIn(element: Element) {
	return element.hasAttribute(RC.ROW_ATTR) ? element : null
}

/** The row and timestamp whose gutter `x`,`y` is in, if any. For a row of several lines, the line at `y`'s. */
export function gutterAt(host: Element, x: number, y: number): { row: Element; time: Element } | null {
	const row = rowAtY(host, y)
	if (!row) return null
	let time: Element | null = null
	for (const candidate of row.querySelectorAll(`[${RC.TIP_TIME_ATTR}]`)) {
		const line = (candidate.parentElement ?? candidate).getBoundingClientRect()
		// a collapsed disclosure's lines have no box
		if (line.height === 0) continue
		time ??= candidate
		if (line.top <= y) time = candidate
	}
	if (!time) return null
	const left = row.getBoundingClientRect().left
	return x >= left && x <= time.getBoundingClientRect().right ? { row, time } : null
}

/** The top-level row `node` belongs to, if it is inside `host`. */
export function rowOf(host: Element, node: Element | null): Element | null {
	let row = node
	while (row && row.parentElement !== host) row = row.parentElement
	return row?.hasAttribute(RC.ROW_ATTR) ? row : null
}

// indices of the two ends among the host's children, lowest first; undefined unless both are present
function bounds(host: Element, selection: RC.RowSelection): [number, number] | undefined {
	const rows = host.children
	let anchor = -1
	let head = -1
	for (let i = 0; i < rows.length && (anchor < 0 || head < 0); i++) {
		if (anchor < 0 && RC.rowHasId(rows[i], selection.anchor)) anchor = i
		if (head < 0 && RC.rowHasId(rows[i], selection.head)) head = i
	}
	if (anchor < 0 || head < 0) return undefined
	return anchor <= head ? [anchor, head] : [head, anchor]
}

/** The selected rows, in document order. Empty while either end is not loaded. */
export function selectedRows(host: Element, selection: RC.RowSelection | undefined): Element[] {
	const range = selection && bounds(host, selection)
	if (!range) return []
	return Array.from(host.children).slice(range[0], range[1] + 1)
}

export function paint(host: Element, selection: RC.RowSelection | undefined = scopeSelection(host)) {
	const range = selection && bounds(host, selection)
	if (!range) {
		for (const row of host.querySelectorAll(`:scope > [${RC.SELECTED_ATTR}]`)) row.removeAttribute(RC.SELECTED_ATTR)
		return
	}
	const rows = host.children
	for (let i = 0; i < rows.length; i++) {
		const selected = i >= range[0] && i <= range[1]
		if (selected !== rows[i].hasAttribute(RC.SELECTED_ATTR)) rows[i].toggleAttribute(RC.SELECTED_ATTR, selected)
	}
}

function scopeSelection(host: Element) {
	const key = keyOf(host)
	return key ? get(key) : undefined
}

export function contains(host: Element, selection: RC.RowSelection | undefined, row: Element): boolean {
	const range = selection && bounds(host, selection)
	if (!range) return false
	const index = Array.prototype.indexOf.call(host.children, row) as number
	return index >= range[0] && index <= range[1]
}

/** The nearest ancestor that actually scrolls, which is not always the one styled to. */
export function scrollParentOf(element: Element): Element | null {
	const root = document.scrollingElement
	for (let node = element.parentElement; node && node !== root; node = node.parentElement) {
		const overflow = getComputedStyle(node).overflowY
		if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node
	}
	// the page itself, whose overflow computes as visible
	return root && root.scrollHeight > root.clientHeight ? root : null
}

/** The part of the viewport a scroller shows its content in. */
export function viewOf(scroller: Element): { top: number; bottom: number; height: number } {
	if (scroller === document.scrollingElement) return { top: 0, bottom: window.innerHeight, height: window.innerHeight }
	const rect = scroller.getBoundingClientRect()
	return { top: rect.top, bottom: rect.bottom, height: rect.height }
}

const REVEAL_MAX_FRAMES = 8

/**
 * Scrolls `row`'s nearest scroller to put the row in the middle of it. Not scrollIntoView, which would also
 * scroll every scroller around that one.
 *
 * Repeated over a few frames: the rows it scrolls past are held at a placeholder height by
 * content-visibility, and take their real size only once they come into view, which moves the row again.
 */
export function revealRow(row: Element, frame = 0) {
	const scroller = scrollParentOf(row)
	if (!scroller || !row.isConnected) return
	const rect = row.getBoundingClientRect()
	const view = viewOf(scroller)
	const delta = rect.top - view.top - (view.height - rect.height) / 2
	const before = scroller.scrollTop
	scroller.scrollTop += delta
	if (Math.abs(scroller.scrollTop - before) < 1 || frame >= REVEAL_MAX_FRAMES) return
	requestAnimationFrame(() => revealRow(row, frame + 1))
}

// -------- as text --------

/**
 * Copies `selection` as text, from wherever its scope keeps its events (see RenderCtx.selectionText). The write
 * starts at once with the text still to come: the text may have to be fetched, and a clipboard write has to begin
 * inside the gesture that asked for it.
 */
export function copySelection(host: Element, selection: RC.RowSelection) {
	const ctx = RC.scopeOf(host)
	if (!ctx?.selectionText) return
	const found = ctx.selectionText(selection, ctx, groupOf(host)).then((res) => {
		if (!res) throw new Error('the selection is not in these results')
		return res
	})
	const write =
		typeof ClipboardItem !== 'undefined'
			? navigator.clipboard.write([
					new ClipboardItem({ 'text/plain': found.then((res) => new Blob([res.text], { type: 'text/plain' })) }),
				])
			: found.then((res) => navigator.clipboard.writeText(res.text))
	void Promise.all([found, write]).then(
		([res]) => toast(...tr.toast(CHAT_Msgs.rowsCopied(res.count))),
		() => toast.error(...tr.toast(CHAT_Msgs.rowsCopyFailed())),
	)
}
