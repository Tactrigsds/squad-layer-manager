// Fragment-based navigation for the settings page. The URL hash holds an element id already emitted by the form/TOC
// (`setting:<path>` or `section:<...>`). Navigating scrolls the custom `main` scroll container and offsets past the
// pinned sticky headers so the target isn't hidden underneath them.

const SCROLL_GAP = 8

// scroll the settings target into view below the pinned sticky-header stack (does not touch the URL)
export function scrollToAnchor(id: string): void {
	const main = document.querySelector('main')
	let el = document.getElementById(id)
	// the target field only exists in the GUI editor; fall back to the global-settings card (e.g. while in JSON mode)
	if (!el && id.startsWith('setting:')) el = document.getElementById('section:global')
	if (!el || !main) return
	// offset by the combined height of every sticky ancestor header (each section fieldset / the settings card)
	let stack = 0
	for (let node: HTMLElement | null = el.parentElement; node && node !== main; node = node.parentElement) {
		const sticky = node.querySelector<HTMLElement>(':scope > [style*="position: sticky"]')
		if (sticky) stack += sticky.getBoundingClientRect().height
	}
	// instant, not smooth: a smooth programmatic scroll across the very tall form gets canceled mid-animation in Chrome
	const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - stack - SCROLL_GAP
	main.scrollTo({ top, behavior: 'auto' })
}

// mark the element the URL fragment points at (styled via [data-anchor-highlight] in index.css). The marker is
// exclusive and persists until the next navigation, so the anchored setting stays visually identifiable.
export function highlightAnchor(id: string): void {
	for (const el of document.querySelectorAll('[data-anchor-highlight]')) el.removeAttribute('data-anchor-highlight')
	document.getElementById(id)?.setAttribute('data-anchor-highlight', 'true')
}

// update the URL hash (so the location is shareable/bookmarkable) without triggering the browser's native jump, then
// scroll with our offset logic. replaceState keeps the history stack clean while browsing the table of contents.
export function navigateToAnchor(id: string): void {
	history.replaceState(history.state, '', `#${id}`)
	scrollToAnchor(id)
	highlightAnchor(id)
}

// the anchor id currently in the URL hash, or null
export function currentAnchor(): string | null {
	const h = window.location.hash.slice(1)
	return h ? decodeURIComponent(h) : null
}
