export type RouteDefinition<Params extends string[] = string[]> = {
	server: string
	client?: string
	handle: 'page' | 'custom'
	websocket: boolean
	params: Params
	link: (args: Params) => string
}
export const routes = {
	...defRoute('/', []),
	...defRoute('/layers', []),

	...defRoute('/filters', []),
	...defRoute('/filters/new', []),
	...defRoute('/filters/:id', ['id'], {
		link: ([id]) => `/filters/${id}`,
	}),

	...defRoute('/mock-server', []),

	...defRoute('/login', [], { handle: 'custom' }),
	...defRoute('/login/callback', [], { handle: 'custom' }),
	...defRoute('/logout', [], { handle: 'custom' }),

	...defRoute('/trpc', [], { handle: 'custom', websocket: true }),
} as const satisfies Record<string, RouteDefinition>
export type Platform = 'client' | 'server'
export type Route<P extends Platform> = (typeof routes)[number][P]

function defRoute<T extends string, GetLink extends RouteDefinition['link'], Params extends string[]>(
	str: T,
	params: Params,
	options?: { handle?: 'page' | 'custom'; websocket?: boolean; link?: GetLink }
) {
	return {
		[str]: {
			server: str,
			client: str,
			params,
			link: options?.link ?? (() => str),
			handle: options?.handle ?? 'page',
			websocket: options?.websocket ?? false,
		} satisfies RouteDefinition<Params>,
	}
}

export function exists<P extends Platform>(route: Route<P>) {
	if (!routes[route]) {
		throw new Error(`Route ${route} is not defined in the routes object`)
	}
	return route
}

export function link<R extends Route<'server'>>(routePath: R, ...args: (typeof routes)[R]['params']) {
	const linkFn = routes[routePath].link
	if (!linkFn) {
		throw new Error(`Route ${routePath} is not defined in the routes array`)
	}
	return linkFn(args)
}
