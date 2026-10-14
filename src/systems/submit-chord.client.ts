// The submit chord: ctrl+enter, or cmd+enter on a mac, declared as the `submit` binding in models/keybinds.models.ts.
// The keybinding dispatcher answers it by clicking the submit button of the scope the key came from: a dialog, window,
// popover or page. Clicking the real button means a disabled button blocks the chord exactly as it blocks the mouse,
// and the hint rendered on that button cannot drift from what the chord does. A dialog or window with no submit button
// keeps the key, and a popover with none passes it to the scope it was opened from.
//
// A click on a submit button, by the chord or the mouse, then closes its scope by clicking the scope's own close
// control (CLOSE_ATTR), unless the button's click handler called preventDefault() or the button is marked
// 'manual'. 'manual' is for a submit that closes only once an async call succeeds, or that keeps its scope open.
// A scope the handler already closed is not closed twice, and a scope with no close control stays open.
//
// An input that batches its edits flushes them on the chord's keydown (isSubmitChord). React's listeners run before
// the dispatcher's, so the flush lands before the submit.
import type * as KB from '@/lib/keybinds'
import * as KEYS from '@/models/keybinds.models'
import * as KBClient from '@/systems/keybinds.client'

export const BUTTON_ATTR = 'data-submit-chord'
export const CLOSE_ATTR = 'data-submit-close'

export type ButtonMode = 'close' | 'manual'

export const LABEL = KEYS.label('submit')

export function isSubmitChord(e: KB.KeyEventLike): boolean {
	return KEYS.matches(e, 'submit')
}

export function buttonAttrs(mode: ButtonMode | boolean | undefined) {
	if (!mode) return {}
	return { ...KBClient.buttonAttrs('submit'), [BUTTON_ATTR]: mode === true ? 'close' : mode }
}

export const closeAttrs = { [CLOSE_ATTR]: '' }

// Radix keeps a closing scope's content mounted, as data-state="closed", while it animates out
function isOpen(scope: Element) {
	return scope.isConnected && scope.getAttribute('data-state') !== 'closed' && scope.checkVisibility()
}

function closeControlOf(scope: Element): HTMLElement | null {
	for (const control of scope.querySelectorAll<HTMLElement>(`[${CLOSE_ATTR}]`)) {
		if (KBClient.nearestScopeFor(control, 'submit') === scope) return control
	}
	return null
}

// Captured, because a headlessui dialog panel stops clicks from bubbling out of it. The check waits for a task,
// by which point the button's handlers have run and React has committed what they did.
function onClickCapture(e: MouseEvent) {
	if (!(e.target instanceof Element)) return
	const button = e.target.closest<HTMLElement>(`[${BUTTON_ATTR}]`)
	if (!button || button.getAttribute(BUTTON_ATTR) === 'manual') return
	const scope = KBClient.nearestScopeFor(button, 'submit')
	if (!scope) return
	setTimeout(() => {
		if (e.defaultPrevented || !isOpen(scope)) return
		closeControlOf(scope)?.click()
	})
}

export function setup() {
	// read by css that names the chord without rendering an element for it
	document.documentElement.style.setProperty('--submit-chord', JSON.stringify(LABEL))
	document.addEventListener('click', onClickCapture, { capture: true })
}
