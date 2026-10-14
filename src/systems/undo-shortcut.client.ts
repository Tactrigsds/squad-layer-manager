// Undo and redo keys: ctrl+z, and ctrl+shift+z or ctrl+y, with cmd on a mac. One document listener clicks the undo or
// redo button of the editor the key belongs to, so a disabled button blocks the key exactly as it blocks the mouse. An
// editor marks its root with SCOPE_ATTR and its two buttons with BUTTON_ATTR.
//
// The key belongs to the innermost scope around its target. A key with nothing focused belongs to the scope the user
// last pressed or focused in, since clicking a row's button often removes that button and leaves focus on the body.
// A text field keeps the keys for its own undo, and a key pressed in a dialog or popover outside every scope does
// nothing.

export const SCOPE_ATTR = 'data-undo-scope'
export const BUTTON_ATTR = 'data-undo'

export type Direction = 'undo' | 'redo'

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

export const LABELS: Record<Direction, string> = IS_MAC ? { undo: '⌘Z', redo: '⇧⌘Z' } : { undo: 'Ctrl+Z', redo: 'Ctrl+Y' }
export const ARIA_KEYSHORTCUTS: Record<Direction, string> = IS_MAC
	? { undo: 'Meta+Z', redo: 'Meta+Shift+Z' }
	: { undo: 'Control+Z', redo: 'Control+Y Control+Shift+Z' }

const SCOPE_SELECTOR = `[${SCOPE_ATTR}]`

export function scopeAttrs() {
	return { [SCOPE_ATTR]: '' }
}

export function buttonAttrs(direction: Direction) {
	return { [BUTTON_ATTR]: direction, 'aria-keyshortcuts': ARIA_KEYSHORTCUTS[direction] }
}

export function directionOf(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): Direction | null {
	if (e.altKey || !(IS_MAC ? e.metaKey : e.ctrlKey)) return null
	const key = e.key.toLowerCase()
	if (key === 'z') return e.shiftKey ? 'redo' : 'undo'
	if (key === 'y' && !IS_MAC && !e.shiftKey) return 'redo'
	return null
}

let lastEngaged: Element | null = null

function onEngage(e: Event) {
	lastEngaged = e.target instanceof Element ? e.target.closest(SCOPE_SELECTOR) : null
}

function isTextField(target: Element) {
	return !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
}

function onKeyDown(e: KeyboardEvent) {
	if (e.defaultPrevented) return
	const direction = directionOf(e)
	if (!direction) return
	const target = e.target instanceof Element ? e.target : null
	if (target && isTextField(target)) return
	const scope = target && target !== document.body ? target.closest(SCOPE_SELECTOR) : lastEngaged?.isConnected ? lastEngaged : null
	if (!scope) return
	for (const button of scope.querySelectorAll<HTMLElement>(`[${BUTTON_ATTR}="${direction}"]`)) {
		if (button.closest(SCOPE_SELECTOR) !== scope) continue
		e.preventDefault()
		button.click()
		return
	}
}

export function setup() {
	document.addEventListener('pointerdown', onEngage, { capture: true })
	document.addEventListener('focusin', onEngage, { capture: true })
	document.addEventListener('keydown', onKeyDown)
}
