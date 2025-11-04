import * as TSR from '@tanstack/react-router'
import * as Rx from 'rxjs'
import { routeTree } from './routeTree.gen.ts'

// Register things for typesafety
declare module '@tanstack/react-router' {
	interface Register {
		router: typeof rootRouter
	}
}

export const rootRouter = TSR.createRouter({
	routeTree,
	defaultPreload: 'intent',
	scrollRestoration: true,
})

export const newRoute$ = new Rx.Observable<string>(observer => {
	observer.next(window.location.pathname)
	const unsub = rootRouter.subscribe('onBeforeLoad', (event) => {
		if (!event.pathChanged || !event.toLocation) return
		observer.next(event.toLocation.pathname)
	})
	return () => unsub()
}).pipe(Rx.distinctUntilChanged())

export function createHref() {
	// need to go implement this at some point if we want a universal way to build a link outside of the context of a component
	// https://github.com/TanStack/router/blob/6baffebbcee2454d19bb7206eeaa456ccd30b51f/packages/react-router/src/link.tsx#L121-L142
	throw new Error('Not implemented')
}
