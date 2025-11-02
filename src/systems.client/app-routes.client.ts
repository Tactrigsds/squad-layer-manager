import * as AR from '@/app-routes'
import { useParams } from 'react-router-dom'
import { useLocation } from 'react-router-dom'
import * as Rx from 'rxjs'

export function useRoute() {
	const location = useLocation()
	return AR.resolveRoute(location.pathname)
}

export function useAppParams<R extends AR.KnownRouteId>(_route: R) {
	const params = useParams() as AR.RouteParamObj<R>
	return params
}

export function setCookie(name: AR.CookieKey, value: string) {
	document.cookie = `${name}=${encodeURIComponent(value)}; path=/`
}

export function getCookie(name: AR.CookieKey): string | undefined {
	return AR.parseCookies(document.cookie)[name]
}

export function deleteCookie(name: AR.CookieKey) {
	document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC`
}

// Create observable from MutationObserver to watch for URL changes
// TODO we should probably upgrade react router swap this out with a router integration
const urlChanges$ = new Rx.Observable<string>(observer => {
	let lastPathname = window.location.pathname

	const mutationObserver = new MutationObserver(() => {
		if (window.location.pathname !== lastPathname) {
			lastPathname = window.location.pathname
			observer.next(window.location.pathname)
		}
	})

	// Observe changes to document body that might indicate navigation
	mutationObserver.observe(document.body, {
		childList: true,
		subtree: true,
	})

	return () => mutationObserver.disconnect()
})

export function getCurrentRoute() {
	return AR.resolveRoute(window.location.pathname)
}

export const routeChanges$ = urlChanges$.pipe(
	Rx.map(path => AR.resolveRoute(path)),
	// use asyncScheduler so we're never doing something expensive in the MutationObserver microtask
	Rx.observeOn(Rx.asyncScheduler),
	Rx.share(),
)

export const route$ = routeChanges$.pipe(Rx.startWith(getCurrentRoute()))

type InteractType = 'mouseover' | 'mousedown' | 'navigated'
type Interaction = { action: InteractType } & AR.ResolvedRoute

export const linkInteract$ = Rx.merge(
	Rx.fromEvent(document, 'mouseover'),
	Rx.fromEvent(document, 'mousedown'),
).pipe(
	Rx.concatMap((e): Rx.Observable<Interaction> => {
		const type = e.type as 'mouseover' | 'mousedown'
		// @ts-expect-error oh well
		if (!e.target?.tagName !== 'A') return Rx.EMPTY
		const elt = e.target as HTMLAnchorElement
		const urlObj = new URL(elt.href)
		if (urlObj.protocol.startsWith('http') && urlObj.hostname !== window.location.hostname) return Rx.EMPTY

		const route = AR.resolveRoute(urlObj.pathname)
		if (!route || route.def.handle !== 'page') return Rx.EMPTY

		return Rx.of({ action: type, ...route })
	}),
)

export function assertActiveRoute(routeId: AR.KnownRouteId) {
	const route = AR.route(routeId)
	const current = getCurrentRoute()
	if (!current) throw new Error(`No route found`)
	if (current.id !== routeId) throw new Error(`Active route is not ${routeId}. Current route is ${current.id}`)
	return route
}
