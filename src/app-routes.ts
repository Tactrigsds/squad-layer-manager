import Cookie from 'cookie'
import { z } from 'zod'

export type RouteDefinition<Params extends string[] = string[], Handle extends 'page' | 'custom' = 'page' | 'custom'> = {
	server: string
	client?: string
	handle: Handle
	websocket: boolean
	params: Params
	link: (...args: Params) => string
}
export const routes = {
	...defRoute('/', [], 'page'),
	...defRoute('/servers/:id', ['id'], 'page', { link: (id) => `/servers/${id}` }),

	...defRoute('/filters', [], 'page'),
	...defRoute('/filters/new', [], 'page'),
	...defRoute('/filters/:id', ['id'], 'page', { link: (id) => `/filters/${id}` }),
	...defRoute('/layers/:id', ['id'], 'page', { link: (id) => `/layers/${id}` }),

	...defRoute('/login', [], 'custom'),
	...defRoute('/login/callback', [], 'custom'),
	...defRoute('/logout', [], 'custom'),
	...defRoute('/layers.sqlite3', [], 'custom'),
	...defRoute('/check-auth', [], 'custom'),

	// proxy avatars
	...defRoute('/avatars/:discordId/:avatarId', ['discordId', 'avatarId'], 'custom', {
		link: (discordId, avatarId) => `/avatars/${discordId}/${avatarId}`,
	}),

	...defRoute('/trpc', [], 'custom', { websocket: true }),
} as const satisfies Record<string, RouteDefinition>
export type Platform = 'client' | 'server'
export type Route<P extends Platform> = (typeof routes)[number][P]

export type RouteParamObj<R extends Route<'server'>> = (typeof routes)[number]['params'] extends never[] ? never
	: Record<(typeof routes)[R]['params'][number], string>

export type ResolvedRoute<R extends Route<'server'> = Route<'server'>> = {
	id: R
	def: (typeof routes)[number]
	params: RouteParamObj<R>
}

function defRoute<T extends string, GetLink extends RouteDefinition['link'], Params extends string[], Handle extends 'page' | 'custom'>(
	str: T,
	params: Params,
	handle: Handle,
	options?: { websocket?: boolean; link?: GetLink },
) {
	return {
		[str]: {
			server: str,
			client: str,
			params,
			link: options?.link ?? (() => str),
			handle: handle,
			websocket: options?.websocket ?? false,
		} satisfies RouteDefinition<Params, Handle>,
	}
}

export function route<P extends Platform>(path: Route<P>) {
	if (!routes[path]) {
		throw new Error(`Route ${path} is not defined in the routes object`)
	}
	return path
}

export function link<R extends Route<'server'>>(path: R, ...args: (typeof routes)[R]['params']) {
	const linkFn = routes[path].link
	if (!linkFn) {
		throw new Error(`Route ${path} is not defined in the routes object`)
	}
	// @ts-expect-error idgaf
	return linkFn(...args)
}

export function isRouteType<T extends 'page' | 'custom'>(
	route: RouteDefinition,
	handle: T,
): route is Extract<RouteDefinition, { handle: T }> {
	return route.handle === handle
}

export function resolveRoute(path: string, opts?: { expectedHandleType?: 'page' | 'custom' }): ResolvedRoute<Route<'server'>> | null {
	const pathSplit = path.replace(/\/$/, '').split('/')
	for (const routePath in routes) {
		const routeSplit = routePath.replace(/\/$/, '').split('/')
		if (routeSplit.length !== pathSplit.length) continue
		let found = true
		const params: Record<string, string> = {}
		for (let i = 0; i < routeSplit.length; i++) {
			const routeSegment = routeSplit[i]
			const pathSegment = pathSplit[i]
			if (routeSegment.match(/^:/)) {
				if (!pathSegment) {
					found = false
					break
				}
				const paramName = routeSegment.substring(1)
				params[paramName] = pathSegment
				continue
			}
			if (routeSegment !== pathSegment) {
				found = false
				break
			}
		}
		if (found) {
			const route = routes[routePath as Route<'server'>]
			if (opts?.expectedHandleType && route.handle !== opts.expectedHandleType) return null
			return {
				id: routePath as Route<'server'>,
				def: route,
				params: params as RouteParamObj<Route<'server'>>,
			}
		}
	}

	return null
}

export function getRouteRegex(id: string): RegExp {
	// Handle root path specially
	if (id === '/') {
		return new RegExp(`^/?(?:\\?.*)?$`)
	}

	// Remove trailing slash and escape special regex characters
	const cleanPath = id.replace(/\/$/, '')
	const regex = cleanPath.split('/').map((segment) => {
		if (segment.startsWith(':')) {
			// Ensure parameter captures at least one character, but stop at query params
			return `([^/?]+)`
		}
		// Escape special regex characters
		return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	}).join('/')

	return new RegExp(`^${regex}/?(?:\\?.*)?$`)
}

export const COOKIE_KEY = z.enum([
	// stores the squad server that should be defaulted to on page load.
	'default-server-id',

	// stores the session id for the user. the client always expects this cookie to be present.
	'session-id',
])
export type CookieKey = z.infer<typeof COOKIE_KEY>

export type Cookies = Record<CookieKey, string | undefined>

export function parseCookies(raw: string) {
	return Cookie.parse(raw) as Cookies
}
