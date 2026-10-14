// The submit chord: ctrl+enter, or cmd+enter on a mac. One document listener clicks the submit button of the scope
// the key event came from. A scope is a dialog, window, popover or page carrying SCOPE_ATTR, and its submit button
// is the first element carrying BUTTON_ATTR that does not sit in a nested scope. Clicking the real button means a
// disabled button blocks the chord exactly as it blocks the mouse, and the hint rendered on that button cannot drift
// from what the chord does.
//
// A click on a submit button, by the chord or the mouse, then closes its scope by clicking the scope's own close
// control (CLOSE_ATTR), unless the button's click handler called preventDefault() or the button is marked
// 'manual'. 'manual' is for a submit that closes only once an async call succeeds, or that keeps its scope open.
// A scope the handler already closed is not closed twice, and a scope with no close control stays open.
//
// A 'dialog', 'window' or 'page' scope owns the chord even with no submit button, so a chord never submits a scope
// hidden under another. A 'popover' scope without a submit button hands the chord to the scope around the popover's
// trigger, which is where the popover opened from, though it is portalled elsewhere. A key event that targets
// `body` (nothing focused) goes to the last open dialog, or failing that to the page. Windows are left out of that
// fallback: they float beside the page rather than over it.
//
// A component that gives the chord its own meaning (a combo box toggling its highlighted option) handles it on
// keydown and calls preventDefault(), which this listener respects. React's listeners run before this one. An input
// that batches its edits flushes them on the chord's keydown, for the same reason.

export const SCOPE_ATTR = 'data-submit-scope'
export const BUTTON_ATTR = 'data-submit-chord'
export const CLOSE_ATTR = 'data-submit-close'

export type ScopeKind = 'dialog' | 'window' | 'popover' | 'page'
export type ButtonMode = 'close' | 'manual'

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export const MODIFIER_LABEL = IS_MAC ? '⌘' : 'Ctrl'
export const ENTER_LABEL = '↵'
export const LABEL = `${MODIFIER_LABEL} ${ENTER_LABEL}`
export const ARIA_KEYSHORTCUTS = IS_MAC ? 'Meta+Enter' : 'Control+Enter'

export function isSubmitChord(e: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
	return e.key === 'Enter' && (e.ctrlKey || e.metaKey)
}

export function scopeAttrs(kind: ScopeKind) {
	return { [SCOPE_ATTR]: kind }
}

export function buttonAttrs(mode: ButtonMode | boolean | undefined) {
	if (!mode) return {}
	return { [BUTTON_ATTR]: mode === true ? 'close' : mode, 'aria-keyshortcuts': ARIA_KEYSHORTCUTS }
}

export const closeAttrs = { [CLOSE_ATTR]: '' }

const SCOPE_SELECTOR = `[${SCOPE_ATTR}]`

// Radix keeps a closing scope's content mounted, as data-state="closed", while it animates out
function isOpen(scope: HTMLElement) {
	return scope.isConnected && scope.getAttribute('data-state') !== 'closed' && scope.checkVisibility()
}

function ownedBy(scope: Element, selector: string): HTMLElement | null {
	for (const el of scope.querySelectorAll<HTMLElement>(selector)) {
		if (el.closest(SCOPE_SELECTOR) === scope) return el
	}
	return null
}

function scopeFor(target: EventTarget | null): Element | null {
	if (target instanceof Element && target !== document.body) return target.closest(SCOPE_SELECTOR)
	const dialogs = [...document.querySelectorAll<HTMLElement>(`[${SCOPE_ATTR}="dialog"]`)].filter(isOpen)
	return dialogs.at(-1) ?? document.querySelector(`[${SCOPE_ATTR}="page"]`)
}

function onKeyDown(e: KeyboardEvent) {
	if (e.defaultPrevented || e.repeat || !isSubmitChord(e)) return
	let scope = scopeFor(e.target)
	while (scope) {
		const button = ownedBy(scope, `[${BUTTON_ATTR}]`)
		if (button) {
			e.preventDefault()
			button.click()
			return
		}
		if (scope.getAttribute(SCOPE_ATTR) !== 'popover') {
			e.preventDefault()
			return
		}
		const trigger = scope.id ? document.querySelector(`[aria-controls="${CSS.escape(scope.id)}"]`) : null
		scope = trigger?.closest(SCOPE_SELECTOR) ?? null
	}
}

// Captured, because a headlessui dialog panel stops clicks from bubbling out of it. The check waits for a task,
// by which point the button's handlers have run and React has committed what they did.
function onClickCapture(e: MouseEvent) {
	if (!(e.target instanceof Element)) return
	const button = e.target.closest<HTMLElement>(`[${BUTTON_ATTR}]`)
	if (!button || button.getAttribute(BUTTON_ATTR) === 'manual') return
	const scope = button.closest<HTMLElement>(SCOPE_SELECTOR)
	if (!scope) return
	setTimeout(() => {
		if (e.defaultPrevented || !isOpen(scope)) return
		ownedBy(scope, `[${CLOSE_ATTR}]`)?.click()
	})
}

export function setup() {
	// read by css that names the chord without rendering an element for it
	document.documentElement.style.setProperty('--submit-chord', JSON.stringify(LABEL))
	document.addEventListener('keydown', onKeyDown)
	document.addEventListener('click', onClickCapture, { capture: true })
}
