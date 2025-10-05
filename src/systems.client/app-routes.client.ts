import { useParams } from 'react-router-dom'
import { useLocation } from 'react-router-dom'

import * as AR from '@/app-routes'
import { Route, routes } from '@/app-routes'

export function useRoute() {
	const location = useLocation()
	return AR.resolveRoute(location.pathname)
}

export function useAppParams<R extends Route<'server'>>(_route: R) {
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
