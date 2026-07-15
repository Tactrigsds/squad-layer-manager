// Fragment-based navigation for the settings page. The URL hash holds an element id already emitted by the form/TOC
// (`setting:<path>` or `section:<...>`). Navigating scrolls the custom `main` scroll container and offsets past the
// pinned sticky headers so the target isn't hidden underneath them.

const SCROLL_GAP = 8

// the section-level anchor that owns a given anchor id. A `setting:*` field degrades to its `section:*` header when the
// field itself isn't rendered (the section is in JSON mode, or hasn't mounted yet). Returns null for unrecognized ids.
export function sectionForAnchor(id: string): string | null {
	if (id.startsWith('section:')) return id
	if (id.startsWith('setting:server:')) {
		const rest = id.slice('setting:server:'.length)
		const sep = rest.indexOf(':')
		const serverId = sep === -1 ? rest : rest.slice(0, sep)
		return serverId ? `section:server:${serverId}` : null
	}
	if (id.startsWith('setting:')) return 'section:global'
	return null
}

// the element an anchor id should scroll to, falling back to the owning section when the exact target isn't in the DOM
function resolveAnchorEl(id: string): HTMLElement | null {
	const el = document.getElementById(id)
	if (el) return el
	const section = sectionForAnchor(id)
	return section && section !== id ? document.getElementById(section) : null
}

// the main scrollTop that lands `el` just below the pinned sticky-header stack (each section fieldset / the settings card)
function desiredScrollTop(el: HTMLElement, main: HTMLElement): number {
	let stack = 0
	for (let node: HTMLElement | null = el.parentElement; node && node !== main; node = node.parentElement) {
		const sticky = node.querySelector<HTMLElement>(':scope > [style*="position: sticky"]')
		if (sticky) stack += sticky.getBoundingClientRect().height
	}
	return el.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - stack - SCROLL_GAP
}

// only one programmatic settle-scroll runs at a time; a newer navigation supersedes an in-flight one
let activeSettle: (() => void) | null = null

// Re-scroll to an anchor until its position stabilizes, absorbing the reflow that keeps shifting the target after it
// first appears (Suspense resolves, drafts load, the lazy CodeMirror bundle mounts, fonts settle). A single one-shot
// scroll lands against a layout that's still moving and drifts off; this keeps correcting until the target's resting
// scrollTop holds for a few frames, or the deadline passes. Abandons early if the user takes over the scroll, so we
// never fight them. If the target hasn't mounted yet it keeps polling (within the deadline) and lands once it does.
// Returns a cancel function; superseded automatically by the next call.
export function scrollToAnchorSettled(id: string, opts?: { deadlineMs?: number; highlight?: boolean }): () => void {
	const main = document.querySelector('main')
	if (!main) return () => {}
	activeSettle?.()

	const deadline = performance.now() + (opts?.deadlineMs ?? 2500)
	let raf = 0
	let stableFrames = 0
	let cancelled = false

	const cancel = () => {
		if (cancelled) return
		cancelled = true
		if (raf) cancelAnimationFrame(raf)
		main.removeEventListener('wheel', onUser)
		main.removeEventListener('touchmove', onUser)
		window.removeEventListener('keydown', onKey)
		if (activeSettle === cancel) activeSettle = null
	}
	const onUser = () => cancel()
	const onKey = (e: KeyboardEvent) => {
		if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) cancel()
	}
	main.addEventListener('wheel', onUser, { passive: true })
	main.addEventListener('touchmove', onUser, { passive: true })
	window.addEventListener('keydown', onKey)

	const tick = () => {
		raf = 0
		if (cancelled) return
		// the scroll container was torn down (page unmounted); stop rather than spin against a detached node
		if (!main.isConnected) {
			cancel()
			return
		}
		const el = resolveAnchorEl(id)
		if (el) {
			// exclusive highlight (styled via [data-anchor-highlight] in index.css), applied here rather than up-front so a
			// field that mounts after its section still gets marked; idempotent so it isn't re-set every frame
			if (opts?.highlight && !el.hasAttribute('data-anchor-highlight')) highlightElement(el)
			const desired = desiredScrollTop(el, main)
			// resting on target for a few consecutive frames means the layout above it has stopped moving
			if (Math.abs(main.scrollTop - desired) < 1) {
				stableFrames++
			} else {
				stableFrames = 0
				main.scrollTo({ top: desired, behavior: 'auto' })
			}
		} else {
			stableFrames = 0
		}
		if ((el && stableFrames >= 3) || performance.now() >= deadline) {
			cancel()
			return
		}
		raf = requestAnimationFrame(tick)
	}
	raf = requestAnimationFrame(tick)
	activeSettle = cancel
	return cancel
}

// mark one element as the anchored target (styled via [data-anchor-highlight] in index.css). The marker is exclusive
// and persists until the next navigation, so the anchored setting stays visually identifiable.
function highlightElement(el: HTMLElement): void {
	for (const other of document.querySelectorAll('[data-anchor-highlight]')) {
		if (other !== el) other.removeAttribute('data-anchor-highlight')
	}
	el.setAttribute('data-anchor-highlight', 'true')
}

// listeners notified on every navigateToAnchor. The server settings pane is master-detail (only the selected server is
// mounted), so it subscribes here to select whichever server an anchor points at before the settle-scroll runs -- else
// navigating to a non-selected server would target an element that isn't in the DOM.
type AnchorListener = (id: string) => void
const anchorListeners = new Set<AnchorListener>()
export function onAnchorNavigate(fn: AnchorListener): () => void {
	anchorListeners.add(fn)
	return () => anchorListeners.delete(fn)
}

// the single entry point for moving to a settings anchor, whether from a TOC click, an initial page-load fragment, or a
// pasted/edited hash. It records the location (replaceState keeps the history stack clean and doesn't trigger the
// browser's native jump; it's a harmless no-op when the hash already matches), then scrolls + highlights via the settle
// pass so the target stays pinned through the reflow of async section content, a GUI/JSON switch, or a section expand.
export function navigateToAnchor(id: string): void {
	history.replaceState(history.state, '', `#${id}`)
	for (const listener of anchorListeners) listener(id)
	scrollToAnchorSettled(id, { highlight: true })
}

// the server id an anchor points at (any `*:server:<id>:*` or `section:server:<id>`), or null. '__new__' is included.
export function serverForAnchor(id: string): string | null {
	const section = sectionForAnchor(id)
	if (!section?.startsWith('section:server:')) return null
	return section.slice('section:server:'.length) || null
}

// the anchor id currently in the URL hash, or null
export function currentAnchor(): string | null {
	const h = window.location.hash.slice(1)
	return h ? decodeURIComponent(h) : null
}
