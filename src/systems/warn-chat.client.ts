import * as ZusUtils from '@/lib/zustand'
import * as AAR from '@/models/admin-action-reasons.models'
import * as SettingsClient from '@/systems/settings.client'
import React from 'react'
import * as Zus from 'zustand'

// Backs the "drop a preset into the box" pickers. The box stays free text, so the picked label is only a claim
// that has to be re-checked at send time: `match` hands back the preset iff the text is still its verbatim
// render, which is what lets the caller route through the admin-action-reason codepath instead of custom text.
export function useAdminReasonDraft(action: AAR.AdminActionType) {
	const [pickedLabel, setPickedLabel] = React.useState<string | null>(null)
	const reasons = ZusUtils.useStore(
		SettingsClient.PublicSettingsStore,
		s => s ? AAR.reasonsForAction(s.adminActionReasons, action) : [],
	)
	const vars = ZusUtils.useStore(
		SettingsClient.PublicSettingsStore,
		s => Object.fromEntries((s?.messageVariables ?? []).map(v => [v.name, v.value])) as Record<string, string>,
	)
	// a pick doesn't survive a change of action -- a warn preset is not a broadcast preset
	React.useEffect(() => setPickedLabel(null), [action])

	// untagged: the server prepends the "@..." audience tag to whatever it's given
	const render = (reason: AAR.AdminActionReason) => AAR.formatAppliedReason(action, reason, { vars }).trim()
	return {
		reasons,
		render,
		pick(reason: AAR.AdminActionReason) {
			setPickedLabel(reason.label)
			return render(reason)
		},
		reset: () => setPickedLabel(null),
		match(text: string) {
			const picked = reasons.find(r => r.label === pickedLabel)
			return picked && text === render(picked) ? picked : undefined
		},
	}
}

// Identifies which warn chat box a "warn X" menu action wants to hand focus to.
export type WarnFocusTarget =
	| { kind: 'player'; playerId: string }
	| { kind: 'squad'; uniqueSquadId: number }
	| { kind: 'server-activity' }

type WarnFocusState = { requestId: number; target: WarnFocusTarget | null; at: number }

// A warn box may be mounted a beat after the action fires (the action opens its window first), so a request
// is honored on mount as well as live. To avoid a stale request re-focusing a window that is later reopened
// by hand, mount-time consumption is bounded by this freshness window; live requests always land well within
// it since they fire the same tick.
const FRESHNESS_MS = 8000

// Bumped whenever a warn action wants a warn chat box to take focus.
export const WarnFocusStore = Zus.createStore<WarnFocusState>(() => ({ requestId: 0, target: null, at: 0 }))

export function requestWarnFocus(target: WarnFocusTarget) {
	WarnFocusStore.setState(s => ({ requestId: s.requestId + 1, target, at: Date.now() }))
}

// A context menu traps focus (Radix FocusScope) while it's open, and its exit animation keeps that scope
// mounted a couple hundred ms after the click — so focusing the warn box during that window is fought by the
// trap and ends up on <body> once the menu unmounts. The menu's close handler consults this and, if a warn
// was just requested, re-fires the focus once the scope is gone (see refireWarnFocus).
export function warnFocusJustRequested() {
	return Date.now() - WarnFocusStore.getState().at < 1000
}

// Re-emit the current focus request (new id) so warn boxes focus again — used from a context menu's close
// handler, at which point the menu's focus trap has been released and the focus can actually stick.
export function refireWarnFocus() {
	const { target } = WarnFocusStore.getState()
	if (target) requestWarnFocus(target)
}

// Focuses the target element, re-asserting each frame until the focus actually sticks (or we give up after
// ~20 frames). A single deferred .focus() is unreliable here for several reasons, all of which "retry until
// it's the active element" absorbs:
//   - the context menu that triggered this restores focus to its trigger as it closes, stealing ours; the
//     timing of that restore races our attempt (especially for windows that mount async), so we just keep
//     reclaiming until the (one-time) steal is done
//   - a warn box lives behind a tab (single-column) or inside a freshly-opened window that is momentarily
//     display:none / visibility:hidden — .focus() is a no-op while hidden, so activeElement stays wrong and
//     we retry until it becomes focusable
export function focusWhenVisible(getEl: () => HTMLElement | null | undefined, tries = 20) {
	requestAnimationFrame(() => {
		const el = getEl()
		if (!el || tries <= 0) return
		if (document.activeElement === el) return // stuck — done
		el.focus()
		focusWhenVisible(getEl, tries - 1)
	})
}

// Runs `onFocus` when the current focus request's target matches, consuming any request already pending at
// mount time. `matches`/`onFocus` are read through refs so the single subscription stays live without
// re-subscribing each render.
export function useWarnFocusRequest(matches: (t: WarnFocusTarget) => boolean, onFocus: () => void) {
	const matchesRef = React.useRef(matches)
	const onFocusRef = React.useRef(onFocus)
	matchesRef.current = matches
	onFocusRef.current = onFocus
	const lastConsumed = React.useRef(0)
	React.useEffect(() => {
		const check = (s: WarnFocusState) => {
			if (!s.target || s.requestId <= lastConsumed.current) return
			if (Date.now() - s.at > FRESHNESS_MS) return
			if (!matchesRef.current(s.target)) return
			lastConsumed.current = s.requestId
			onFocusRef.current()
		}
		check(WarnFocusStore.getState())
		return WarnFocusStore.subscribe(check)
	}, [])
}
