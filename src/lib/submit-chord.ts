// The submit chord: ctrl+enter, or cmd+enter on a mac. One document listener clicks the submit button of the scope
// the key event came from. A scope is any element carrying SCOPE_ATTR, and its submit button is the first element
// carrying BUTTON_ATTR that does not sit in a nested scope. Clicking the real button means a disabled button blocks
// the chord exactly as it blocks the mouse, and the hint rendered on that button cannot drift from what the chord does.
//
// A component that gives the chord its own meaning handles it on keydown and calls preventDefault(), which this
// listener respects. An input that batches its edits flushes them on the chord's keydown, which runs before this
// listener does.

export const SCOPE_ATTR = 'data-submit-scope'
export const BUTTON_ATTR = 'data-submit-chord'

// Values of SCOPE_ATTR. A key event that targets `body` (nothing focused) goes to the last open dialog scope, or
// failing that to the page scope.
export type ScopeKind = 'dialog' | 'page' | 'local'

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

export function buttonAttrs() {
	return { [BUTTON_ATTR]: '', 'aria-keyshortcuts': ARIA_KEYSHORTCUTS }
}

const SCOPE_SELECTOR = `[${SCOPE_ATTR}]`

function scopeFor(target: EventTarget | null): Element | null {
	if (target instanceof Element && target !== document.body) return target.closest(SCOPE_SELECTOR)
	const dialogs = document.querySelectorAll(`[${SCOPE_ATTR}="dialog"]`)
	if (dialogs.length > 0) return dialogs[dialogs.length - 1]
	return document.querySelector(`[${SCOPE_ATTR}="page"]`)
}

function buttonFor(scope: Element): HTMLElement | null {
	for (const el of scope.querySelectorAll<HTMLElement>(`[${BUTTON_ATTR}]`)) {
		if (el.closest(SCOPE_SELECTOR) === scope) return el
	}
	return null
}

function onKeyDown(e: KeyboardEvent) {
	if (e.defaultPrevented || e.repeat || !isSubmitChord(e)) return
	const scope = scopeFor(e.target)
	const button = scope && buttonFor(scope)
	if (!button) return
	e.preventDefault()
	button.click()
}

export function setup() {
	// read by css that names the chord without rendering an element for it
	document.documentElement.style.setProperty('--submit-chord', JSON.stringify(LABEL))
	document.addEventListener('keydown', onKeyDown)
}
