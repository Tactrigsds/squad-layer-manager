// NOTE: we can't import anything here that would require a path alias, even recursively because it's used in vite.config.ts

import Cookie from 'cookie'
import { z } from 'zod'
import * as Arr from './lib/array'
import { MapTuple } from './lib/types'

type GenericRouteDefinition = {
	id: string
	handle: 'page' | 'custom'
	websocket: boolean
	params: ParamsBase
	link: ((...args: string[]) => string) | ((...args: never[]) => string)
	regex: RegExp
}

type ParamsBase = [string, ...string[]] | never[]

export type RouteDefinition<Params extends ParamsBase, Handle extends 'page' | 'custom'> = {
	id: string
	handle: Handle
	websocket: boolean
	params: Params
	link: GetLink<Params>
	regex: RegExp
}

type GetLink<Params extends ParamsBase> = (...args: Params) => string

export const routes = {
	...defRoute('/', [], 'page'),
	...defRoute('/servers/:id', ['id'] as const, 'page'),

	...defRoute('/filters', [], 'page'),
	...defRoute('/filters/new', [], 'page'),
	...defRoute('/filters/:id', ['id'] as const, 'page'),
	...defRoute('/layers/:id', ['id'] as const, 'page'),
	...defRoute('/layers/:id/scores', ['id'] as const, 'page'),

	...defRoute('/login', [], 'custom'),
	...defRoute('/login/callback', [], 'custom'),
	...defRoute('/logout', [], 'custom'),
	...defRoute('/layers.sqlite3', [], 'custom'),
	...defRoute('/check-auth', [], 'custom'),

	...defRoute('/discord-cdn/*', ['*'] as const, 'custom'),

	...defRoute('/trpc', [], 'custom', { websocket: true }),
} as const satisfies Record<string, GenericRouteDefinition>

export type KnownRoutes = typeof routes
export type KnownRoute = KnownRoutes[number]
export type KnownRouteId = KnownRoute['id']
export type PageRoutes = Extract<KnownRoute, { handle: 'page' }>
export type RouteDefForId<R extends KnownRouteId> = Extract<KnownRoutes[number], { id: R }>

export type RouteParamObj<R extends KnownRouteId> = RouteDefForId<R>['params'] extends never[] ? never
	: { [k in RouteDefForId<R>['params'][number]]: string }

export type ResolvedRoute<R extends KnownRouteId = KnownRouteId> = {
	id: R
	def: RouteDefForId<R>
	params: RouteParamObj<R>
}

function defRoute<T extends string, Params extends ParamsBase, Handle extends 'page' | 'custom'>(
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
			id: str,
			params: params as Params,

			link: getLink,

			handle: handle,
			websocket: options?.websocket ?? false,
			regex: getRouteRegex(str),
		} satisfies RouteDefinition<Params, Handle>,
	} as const
}

export function route<R extends KnownRouteId>(path: R) {
	if (!routes[path]) {
		throw new Error(`Route ${path} is not defined in the routes object`)
	}
	return path
}

export function link<R extends KnownRouteId>(path: R, ...args: MapTuple<KnownRoutes[R]['params'], string>) {
	const linkFn = routes[path].link
	// @ts-expect-error idgaf
	return linkFn(...args)
}

export function checkResolvedRouteInIds<R extends KnownRouteId>(
	resolvedRoute: ResolvedRoute<KnownRouteId> | undefined | null,
	...targets: R[]
): ResolvedRoute<R> | undefined {
	if (!resolvedRoute) return
	if (!Arr.includes(targets, resolvedRoute.def.id)) return
	return resolvedRoute as unknown as ResolvedRoute<R>
}

export function isRouteOfHandleType<T extends 'page' | 'custom'>(
	route: GenericRouteDefinition,
	handle: T,
): route is Extract<GenericRouteDefinition, { handle: T }> {
	return route.handle === handle
}

export function resolveRoute(path: string, opts?: { expectedHandleType?: 'page' | 'custom' }): ResolvedRoute | null {
	for (const routeDef of Object.values(routes)) {
		// if (path.includes('scores') && routeDef.id === '/layers/:id/scores') debugger
		const match = routeDef.regex.exec(path)
		if (!match) continue

		const params: Record<string, string> = {}
		if (match.groups) {
			for (const [key, value] of Object.entries(match.groups)) {
				if (value !== undefined) {
					params[key.startsWith('__glob') ? '*' : key] = value
				}
			}
		}

		if (opts?.expectedHandleType && routeDef.handle !== opts.expectedHandleType) return null
		return {
			id: routeDef.id,
			def: routeDef,
			params: params as RouteParamObj<KnownRouteId>,
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
