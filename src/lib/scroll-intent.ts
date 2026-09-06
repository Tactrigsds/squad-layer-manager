// At the scroll event, a scroll made by code on the reader's behalf (a find bar bringing a match into view) looks
// the same as one made by code correcting for layout. Code scrolling because the reader asked it to announces the
// scroll here first, so that a scroll manager attributing gestures to the reader can count it as one.

export const EVENT = 'slm:scroll-intent'

export function announce(el: Element) {
	el.dispatchEvent(new Event(EVENT, { bubbles: true }))
}
