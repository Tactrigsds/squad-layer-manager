/**
 * Whether a text field has focus, which on a phone means the on-screen keyboard is up. The phone layout hides its
 * chrome (the nav bar and the tab bars) meanwhile, so the field and what it edits get the room the keyboard leaves.
 *
 * Focus leaving a field under a finger is held until the tap completes. Showing the chrome moves everything below
 * it, so a tap that blurs the field would otherwise land on whatever moved under the finger.
 */
import * as Browser from '@/lib/browser'
import * as Zus from '@/lib/zustand'

const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color', 'range', 'image', 'hidden'])

let Store!: Zus.StoreApi<{ focused: boolean }>

function isTextEntry(el: EventTarget | null): boolean {
	if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
	if (el instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(el.type) && !el.readOnly && !el.disabled
	return el instanceof HTMLElement && el.isContentEditable
}

export function setup() {
	Store = Zus.createStore<{ focused: boolean }>(() => ({ focused: isTextEntry(document.activeElement) }))
	let pointerDown = false
	let blurPending = false

	const set = (focused: boolean) => {
		blurPending = false
		if (Store.getState().focused !== focused) Store.setState({ focused })
	}

	const leave = () => {
		if (pointerDown) blurPending = true
		else set(false)
	}
	document.addEventListener('focusin', (e) => (isTextEntry(e.target) ? set(true) : leave()))
	document.addEventListener('focusout', (e) => {
		if (!isTextEntry(e.relatedTarget)) leave()
	})
	document.addEventListener('pointerdown', () => (pointerDown = true), { capture: true })
	const release = () => {
		pointerDown = false
		if (!blurPending) return
		// the click follows pointerup in the same task
		setTimeout(() => {
			if (blurPending) set(isTextEntry(document.activeElement))
		})
	}
	document.addEventListener('pointerup', release, { capture: true })
	document.addEventListener('pointercancel', release, { capture: true })
}

/** true while the phone layout should step its chrome aside for the on-screen keyboard */
export function usePhoneChromeHidden() {
	const phone = Browser.useIsSmallViewport()
	const touch = Browser.useCoarsePointer()
	const focused = Zus.useStore(Store, (s) => s.focused)
	return phone && touch && focused
}
