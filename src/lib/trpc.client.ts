import { createTRPCClient } from '@trpc/client'
import { createTRPCReact, createWSClient, wsLink } from '@trpc/react-query'
import { globalToast$ } from '@/hooks/use-global-toast'

import superjson from 'superjson'

import * as AR from '@/app-routes'
import type { AppRouter } from '@/server/router'

const wsHostname = window.location.origin.replace(/^http/, 'ws').replace(/\/$/, '')
const wsUrl = `${wsHostname}${AR.exists('/trpc')}`
export const links = [
	wsLink({
		client: createWSClient({
			url: wsUrl,
			onError: () => {
				globalToast$.next({ title: 'An error occured while sending data to the server. Try refreshing the page', variant: 'destructive' })
			},
			onClose: () => {
				globalToast$.next({ title: 'WebSocket connection closed. server may be offline', variant: 'destructive' })
			},
			onOpen: () => {
				console.log('WebSocket connection opened')
			},
		}),
		transformer: superjson,
	}),
]

export const trpc = createTRPCClient<AppRouter>({ links })

// @ts-expect-error binding to window for debugging
window.trpc = trpc

/**
 * @deprecated bad library, phase this out. doesn't handle transports well and a bug in its subscription implementation caused me great pain
 */
export const trpcReact = createTRPCReact<AppRouter>()

export function hashQueryKey(queryKey: any): string {
	return superjson.stringify(queryKey)
}
