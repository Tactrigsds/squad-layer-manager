/**
 * Gives each fullscreen overlay open on a phone (dialogs, sheets, draggable windows) a history entry of its own, so
 * the back gesture closes the top overlay instead of leaving the page.
 *
 * An overlay entry is a copy of the router's current entry, same URL and same `__TSR_key`, plus a marker naming the
 * overlay. It is pushed with the native `History.prototype.pushState`, past TanStack's patched instance method: the
 * router reloads its matches and resets scroll on any push it sees, even to the same href. A popstate between two
 * entries of the router's current key is ours alone, so it is stopped before TanStack's listener runs, which also
 * keeps it from the router's blockers. `createRouterHistory` registers our listener before creating TanStack's
 * history, because listeners on `window` run in the order they were added.
 *
 * A router replace while an overlay entry is current gives that entry a new key, and leaves the entries behind it on
 * the old one. The old key is recorded as superseded, so those entries still count as the current page, and one is
 * brought up to the router's location when back lands on it.
 *
 * Entries are ordered by `(__TSR_index, depth)`: an overlay entry carries its page's index and its depth above that
 * page. On a popstate, every live overlay whose entry now sits ahead of the current one is closed. An entry whose
 * overlay is no longer open is stale and is skipped in the direction of travel. Stale entries are left behind by a
 * route change from inside an overlay, a viewport change, a reload, or a forward press.
 *
 * Closing an overlay from inside the app (button, Escape, scrim) settles history: when the current entry is the
 * closed overlay's, it steps back to the nearest live overlay's entry or to the page. Router navigations and overlay
 * pushes made while that step is in flight wait for it, since a push issued before the traversal lands would be
 * undone by it.
 */
import * as TSR from '@tanstack/react-router'
import React from 'react'

import * as Browser from '@/lib/browser'
import { createId } from '@/lib/id'

const MARKER = '__slmOverlay'

type Marker = { token: string; depth: number }
type EntryState = { __TSR_key?: string; __TSR_index?: number; [MARKER]?: Marker } | null
type Pos = { index: number; depth: number }

type Overlay = {
	token: string
	key: string | undefined
	pos: Pos
	close: () => void
	released: boolean
}

let routerHistory: TSR.RouterHistory | undefined
// in entry order, which is also open order: an overlay opens past every live overlay's entry
const live: Overlay[] = []
let last: Pos = { index: 0, depth: 0 }
let settling = false
let settleQueued = false
const deferred: (() => void)[] = []
// a popstate handed to the router, kept until the router accepts or blocks it
let awaitingRouter: EntryState | undefined
// set when a blocker refused a traversal: the router reverts it with a popstate it expects to see itself
let passNextPop = false
// router keys replaced while an overlay entry was current, mapped to the key that replaced them
const supersededBy = new Map<string, string>()

const entryState = (): EntryState => window.history.state as EntryState
const posOf = (state: EntryState): Pos => ({ index: state?.__TSR_index ?? 0, depth: state?.[MARKER]?.depth ?? 0 })
const cmp = (a: Pos, b: Pos) => a.index - b.index || a.depth - b.depth
const isLive = (token: string) => live.some((o) => o.token === token)
const routerState = () => routerHistory!.location.state as EntryState
function currentKey(key: string | undefined) {
	while (key !== undefined && supersededBy.has(key)) key = supersededBy.get(key)
	return key
}
const isRouterEntry = (state: EntryState) => currentKey(state?.__TSR_key) === routerState()?.__TSR_key

/** The browser history for the router. Pass it to `createRouter` before anything else listens for popstate. */
export function createRouterHistory(): TSR.RouterHistory {
	window.addEventListener('popstate', onPopState)
	const history = TSR.createBrowserHistory()
	routerHistory = history
	last = posOf(entryState())
	history.subscribe(onRouterNotify)

	const push = history.push
	history.push = (path, state, opts) =>
		runWhenSettled(() => {
			push(path, state, opts)
			last = { index: routerState()?.__TSR_index ?? 0, depth: 0 }
		})
	const replace = history.replace
	history.replace = (path, state, opts) =>
		runWhenSettled(() => {
			history.flush()
			const marker = entryState()?.[MARKER]
			const before = routerState()?.__TSR_key
			replace(path, marker ? { ...state, [MARKER]: marker } : state, opts)
			const after = routerState()?.__TSR_key
			if (marker && before && after && before !== after) supersededBy.set(before, after)
		})

	// a reload keeps the entry it happened on, and its overlay is gone
	settle()
	return history
}

/** Pushes a history entry while `open` is true on a phone, and calls `onClose` when back pops it. */
export function useBackDismiss(open: boolean, onClose: () => void) {
	const phone = Browser.useIsSmallViewport()
	const onCloseRef = React.useRef(onClose)
	React.useLayoutEffect(() => {
		onCloseRef.current = onClose
	})
	React.useEffect(() => {
		if (!open || !phone || !routerHistory) return
		const overlay = openOverlay(() => onCloseRef.current())
		return () => release(overlay)
	}, [open, phone])
}

function openOverlay(close: () => void): Overlay {
	const overlay: Overlay = { token: createId(8), key: undefined, pos: { index: 0, depth: 0 }, close, released: false }
	// a microtask lets an open released in the same tick, as by StrictMode's effect replay, push nothing
	queueMicrotask(() => runWhenSettled(() => pushEntry(overlay)))
	return overlay
}

function pushEntry(overlay: Overlay) {
	if (overlay.released) return
	// a navigation the router has queued but not flushed would otherwise land after this entry
	routerHistory!.flush()
	const state = entryState()
	const depth = (state?.[MARKER]?.depth ?? 0) + 1
	overlay.key = state?.__TSR_key
	overlay.pos = { index: state?.__TSR_index ?? 0, depth }
	History.prototype.pushState.call(window.history, { ...state, [MARKER]: { token: overlay.token, depth } }, '')
	live.push(overlay)
	last = overlay.pos
}

function release(overlay: Overlay) {
	overlay.released = true
	const i = live.indexOf(overlay)
	if (i === -1) return
	live.splice(i, 1)
	if (settleQueued) return
	settleQueued = true
	// batches the closes of nested overlays unmounting together into one traversal
	queueMicrotask(() => {
		settleQueued = false
		settle()
	})
}

function runWhenSettled(op: () => void) {
	if (settling) deferred.push(op)
	else op()
}

function settle() {
	if (settling) return
	const state = entryState()
	const marker = state?.[MARKER]
	if (!marker || isLive(marker.token) || !isRouterEntry(state)) return
	const page = currentKey(state.__TSR_key)
	let target = 0
	for (const o of live) {
		if (currentKey(o.key) === page && o.pos.depth < marker.depth) target = Math.max(target, o.pos.depth)
	}
	settling = true
	window.history.go(target - marker.depth)
}

function onPopState(event: PopStateEvent) {
	const state = entryState()
	if (passNextPop) {
		passNextPop = false
		last = posOf(state)
		return
	}
	if (!isRouterEntry(state)) {
		awaitingRouter = state
		return
	}
	event.stopImmediatePropagation()
	if (state?.__TSR_key !== routerState()?.__TSR_key) {
		const marker = state?.[MARKER]
		const synced = marker ? { ...routerState(), [MARKER]: marker } : routerState()
		History.prototype.replaceState.call(window.history, synced, '', routerHistory!.location.href)
	}
	apply(state)
}

function onRouterNotify() {
	if (awaitingRouter === undefined) return
	const state = awaitingRouter
	awaitingRouter = undefined
	if (isRouterEntry(state)) apply(state)
	else passNextPop = true
}

function apply(state: EntryState) {
	const to = posOf(state)
	const from = last
	last = to

	while (live.length > 0 && cmp(live[live.length - 1].pos, to) > 0) {
		const overlay = live.pop()!
		overlay.released = true
		overlay.close()
	}

	if (settling) {
		settling = false
		settle()
		while (!settling && deferred.length > 0) deferred.shift()!()
		return
	}

	const marker = state?.[MARKER]
	if (!marker || isLive(marker.token)) return
	if (cmp(to, from) < 0) window.history.back()
	// a stale entry with nothing past it cannot be skipped forward, so it is backed off instead
	else if (navigationApi()?.canGoForward === false) window.history.back()
	else window.history.forward()
}

function navigationApi(): { canGoForward: boolean } | undefined {
	return 'navigation' in window ? (window.navigation as { canGoForward: boolean }) : undefined
}
