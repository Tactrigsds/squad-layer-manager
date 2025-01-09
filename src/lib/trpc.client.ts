import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import { globalToast$ } from '@/hooks/use-global-toast'
import * as Jotai from 'jotai'

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
				console.log('wtf')
				globalToast$.next({ title: 'An error occured while sending data to the server. Try refreshing the page', variant: 'destructive' })
			},
			onClose: () => {
				console.log('WebSocket connection closed')
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

export function hashQueryKey(queryKey: any): string {
	return superjson.stringify(queryKey)
}
