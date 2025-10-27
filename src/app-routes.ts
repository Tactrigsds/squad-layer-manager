import Cookie from 'cookie'
import { z } from 'zod'

type GenericRouteDefinition = {
	server: string
	client?: string
	handle: 'page' | 'custom'
	websocket: boolean
	params: string[] | never[]
	link: ((...args: string[]) => string) | ((...args: never[]) => string)
	regex: RegExp
}

export type RouteDefinition<Params extends string[], Handle extends 'page' | 'custom'> = {
	server: string
	client?: string
	handle: Handle
	websocket: boolean
	params: Params
	link: GetLink<Params>
	regex: RegExp
}

type GetLink<Params extends string[]> = (...args: Params) => string

export const routes = {
	...defRoute('/', [], 'page'),
	...defRoute('/servers/:id', ['id'], 'page'),

	...defRoute('/filters', [], 'page'),
	...defRoute('/filters/new', [], 'page'),
	...defRoute('/filters/:id', ['id'], 'page'),
	...defRoute('/layers/:id', ['id'], 'page'),

	...defRoute('/login', [], 'custom'),
	...defRoute('/login/callback', [], 'custom'),
	...defRoute('/logout', [], 'custom'),
	...defRoute('/layers.sqlite3', [], 'custom'),
	...defRoute('/check-auth', [], 'custom'),

	...defRoute('/discord-cdn/*', ['*'], 'custom'),

	...defRoute('/trpc', [], 'custom', { websocket: true }),
} as const satisfies Record<string, GenericRouteDefinition>
export type Platform = 'client' | 'server'
export type Route<P extends Platform> = (typeof routes)[number][P]

export type RouteParamObj<R extends Route<'server'>> = (typeof routes)[number]['params'] extends never[] ? never
	: Record<(typeof routes)[R]['params'][number], string>

export type ResolvedRoute<R extends Route<'server'> = Route<'server'>> = {
	id: R
	def: (typeof routes)[number]
	params: RouteParamObj<R>
}

function defRoute<T extends string, Params extends string[] | never[], Handle extends 'page' | 'custom'>(
	str: T,
	params: Params,
	handle: Handle,
	options?: { websocket?: boolean; link?: GetLink<Params> },
) {
	const getLink: GetLink<Params> = options?.link ?? ((...params) => {
		if (params.length === 0) return str
		// first segment will be empty, but that's fine
		const segments = str.split('/')
		const paramSegments = []
		for (let i = 0; i < segments.length; i++) {
			if (segments[i].startsWith(':') || segments[i] === '*') {
				paramSegments.push(i)
			}
		}
		if (paramSegments.length !== params.length) throw new Error(`Invalid number of parameters for route ${str}`)
		for (let i = 0; i < params.length; i++) {
			segments[paramSegments[i]] = params[i].toString()
		}
		return segments.join('/')
	})

	return {
		[str]: {
			server: str,
			client: str,
			params,

			link: getLink,

			handle: handle,
			websocket: options?.websocket ?? false,
			regex: getRouteRegex(str),
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
	// @ts-expect-error idgaf
	return linkFn(...args)
}

export function isRouteType<T extends 'page' | 'custom'>(
	route: GenericRouteDefinition,
	handle: T,
): route is Extract<GenericRouteDefinition, { handle: T }> {
	return route.handle === handle
}

export function resolveRoute(path: string, opts?: { expectedHandleType?: 'page' | 'custom' }): ResolvedRoute<Route<'server'>> | null {
	for (const routePath in routes) {
		const regex = getRouteRegex(routePath as Route<'server'>)
		const match = regex.exec(path)
		if (!match) continue

		const params: Record<string, string> = {}
		if (match.groups) {
			for (const [key, value] of Object.entries(match.groups)) {
				if (value !== undefined) {
					params[key.startsWith('__glob') ? '*' : key] = value
				}
			}
		}

		const route = routes[routePath as Route<'server'>]
		if (opts?.expectedHandleType && route.handle !== opts.expectedHandleType) return null
		return {
			id: routePath as Route<'server'>,
			def: route,
			params: params as RouteParamObj<Route<'server'>>,
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
	let globIdx = 0
	const regex = cleanPath.split('/').map((segment) => {
		if (segment.startsWith('__glob')) throw new Error('Invalid route segment: __glob__')
		if (segment === '*') {
			return `(?<__glob${globIdx++}__>.*)`
		}
		if (segment.startsWith(':')) {
			// Ensure parameter captures at least one character, but stop at query params
			return `(?<${segment.substring(1)}>[^/?]+)`
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
