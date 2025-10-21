import * as AR from '@/app-routes'
import { useParams } from 'react-router-dom'
import { useLocation } from 'react-router-dom'
import * as Rx from 'rxjs'

export function useRoute() {
	const location = useLocation()
	return AR.resolveRoute(location.pathname)
}

export function useAppParams<R extends AR.Route<'server'>>(_route: R) {
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

export const routeChanges$ = urlChanges$.pipe(
	Rx.map(path => AR.resolveRoute(path)),
	// use asyncScheduler so we're never doing something expensive in the MutationObserver microtask
	Rx.observeOn(Rx.asyncScheduler),
	Rx.share(),
)

export const route$ = routeChanges$.pipe(Rx.startWith(AR.resolveRoute(window.location.pathname)))
