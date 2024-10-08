export type RouteDefinition = {
	server: string
	client?: string
	handle: 'page' | 'custom'
	websocket: boolean
	link: (...args: string[]) => string
}
export const routes = [
	defRoute('/'),
	defRoute('/layers'),

	defRoute('/login', { handle: 'custom' }),
	defRoute('/login/callback', { handle: 'custom' }),
	defRoute('/logout', { handle: 'custom' }),

	defRoute('/trpc', { handle: 'custom', websocket: true }),
] satisfies RouteDefinition[]
export type Platform = 'client' | 'server'
export type Route<P extends Platform> = (typeof routes)[number][P]

function defRoute<T extends string>(str: T, options?: { handle?: 'page' | 'custom'; websocket?: boolean }) {
	return {
		server: str,
		client: str,
		link: () => str,
		handle: options?.handle ?? 'page',
		websocket: options?.websocket ?? false,
	} satisfies RouteDefinition
}

export function exists<P extends Platform>(route: Route<P>) {
	if (!routes.some((routeDefinition) => routeDefinition['server'] === route)) {
		throw new Error(`Route ${route} is not defined in the routes array`)
	}
	return route
}

export function getDefinition(route: Route<'server'>) {
	return routes.find((routeDefinition) => routeDefinition.server === route)!
}

export function linkFn(routePath: Route<'client'>) {
	return routes.find((route) => route.client === routePath)!.link
}
