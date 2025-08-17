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

	...defRoute('/filters', [], 'page'),
	...defRoute('/filters/new', [], 'page'),
	...defRoute('/filters/:id', ['id'], 'page', { link: (id) => `/filters/${id}` }),
	...defRoute('/layers/:id', ['id'], 'page', { link: (id) => `/layers/${id}` }),

	...defRoute('/login', [], 'custom'),
	...defRoute('/login/callback', [], 'custom'),
	...defRoute('/logout', [], 'custom'),
	...defRoute('/layers.sqlite3', [], 'custom'),

	...defRoute('/trpc', [], 'custom', { websocket: true }),
} as const satisfies Record<string, RouteDefinition>
export type Platform = 'client' | 'server'
export type Route<P extends Platform> = (typeof routes)[number][P]

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

export function getRouteForPath(path: string, opts?: { expectedHandleType?: 'page' | 'custom' }) {
	const pathSplit = path.replace(/\/$/, '').split('/')
	for (const routePath in routes) {
		const routeSplit = routePath.replace(/\/$/, '').split('/')
		if (routeSplit.length !== pathSplit.length) continue
		let found = true
		for (let i = 0; i < routeSplit.length; i++) {
			const routeSegment = routeSplit[i]
			const pathSegment = pathSplit[i]
			if (routeSegment.match(/^:/)) {
				if (!pathSegment) {
					found = false
					break
				}
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
			return route
		}
	}

	return null
}
