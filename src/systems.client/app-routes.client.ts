import * as AR from '@/app-routes'

export function setCookie(name: AR.CookieKey, value: string) {
	document.cookie = `${name}=${encodeURIComponent(value)}; path=/`
}

export function getCookie(name: AR.CookieKey): string | undefined {
	return AR.parseCookies(document.cookie)[name]
}

export function deleteCookie(name: AR.CookieKey) {
	document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC`
}
