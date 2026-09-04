import * as Zus from '@/lib/zustand'

/**
 * Which site a phone gets. `auto` follows the viewport: below 640px the phone layout, above it the desktop one.
 * `desktop` widens the viewport meta so a phone renders the desktop page and pinches through it; the choice is
 * remembered per device.
 */
export type SiteMode = 'auto' | 'desktop'

const STORAGE_KEY = 'site-mode:v1'
const DESKTOP_VIEWPORT_WIDTH = 1280

let Store!: Zus.StoreApi<{ mode: SiteMode }>

function applyViewport(mode: SiteMode) {
	const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
	if (!meta) return
	meta.content =
		mode === 'desktop'
			? `width=${DESKTOP_VIEWPORT_WIDTH}, initial-scale=0.3, minimum-scale=0.25`
			: 'width=device-width, initial-scale=1.0, interactive-widget=resizes-content'
}

export function setup() {
	const stored = localStorage.getItem(STORAGE_KEY)
	const mode: SiteMode = stored === 'desktop' ? 'desktop' : 'auto'
	applyViewport(mode)
	Store = Zus.createStore<{ mode: SiteMode }>(() => ({ mode }))
}

export function useSiteMode() {
	return Zus.useStore(Store, (s) => s.mode)
}

export function setSiteMode(mode: SiteMode) {
	localStorage.setItem(STORAGE_KEY, mode)
	applyViewport(mode)
	Store.setState({ mode })
}

/** a touch device with a phone user agent, whichever site it is showing */
export function isMobileDevice() {
	const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0
	return hasTouch && /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
}
