import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import { globalToast$ } from '@/hooks/use-global-toast'
import { BehaviorSubject } from 'rxjs'

import superjson from 'superjson'

import * as AR from '@/app-routes'
import type { AppRouter } from '@/server/router'

const wsHostname = window.location.origin.replace(/^http/, 'ws').replace(/\/$/, '')
const wsUrl = `${wsHostname}${AR.exists('/trpc')}`

export const trpcConnected$ = new BehaviorSubject(false)
export const links = [
	wsLink({
		client: createWSClient({
			url: wsUrl,
			onError: () => {
				globalToast$.next({ title: 'An error occured while sending data to the server. Try refreshing the page', variant: 'destructive' })
			},
			onClose: () => {
				globalToast$.next({ title: 'WebSocket connection closed. server may be offline', variant: 'destructive' })
				trpcConnected$.next(false)
			},
			onOpen: () => {
				console.log('WebSocket connection opened')
				trpcConnected$.next(true)
			},
		}),
		transformer: superjson,
	}),
]

export const trpc = createTRPCClient<AppRouter>({ links })

// @ts-expect-error binding to window for debugging
window.trpc = trpc

export function hashQueryKey(queryKey: any): string {
	return superjson.stringify(queryKey)
}
