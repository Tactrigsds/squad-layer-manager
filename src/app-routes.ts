export type RouteDefinition<Params extends string[] = string[]> = {
	server: string
	client?: string
	handle: 'page' | 'custom'
	websocket: boolean
	params: Params
	link: (...args: Params) => string
}
export const routes = {
	...defRoute('/', []),
	...defRoute('/layers', []),

	...defRoute('/filters', []),
	...defRoute('/filters/new', []),
	...defRoute('/filters/:id', ['id'], { link: (id) => `/filters/${id}` }),

	...defRoute('/login', [], { handle: 'custom' }),
	...defRoute('/login/callback', [], { handle: 'custom' }),
	...defRoute('/logout', [], { handle: 'custom' }),
	...defRoute('/layers.sqlite3', [], { handle: 'custom' }),

	...defRoute('/trpc', [], { handle: 'custom', websocket: true }),
} as const satisfies Record<string, RouteDefinition>
export type Platform = 'client' | 'server'
export type Route<P extends Platform> = (typeof routes)[number][P]

function defRoute<T extends string, GetLink extends RouteDefinition['link'], Params extends string[]>(
	str: T,
	params: Params,
	options?: { handle?: 'page' | 'custom'; websocket?: boolean; link?: GetLink },
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
