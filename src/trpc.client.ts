import { globalToast$ } from '@/hooks/use-global-toast'
import { createTRPCClient, createWSClient, WebSocketClientOptions, wsLink } from '@trpc/client'

import superjson from 'superjson'

import * as AR from '@/app-routes'
import type { AppRouter } from '@/server/router'
import { QueryClient } from '@tanstack/react-query'
import { atom, getDefaultStore } from 'jotai'

const wsHostname = window.location.origin.replace(/^http/, 'ws').replace(/\/$/, '')
const wsUrl = `${wsHostname}${AR.exists('/trpc')}`

export const trpcConnectedAtom = atom(null as boolean | null)
const defaultStore = getDefaultStore()

const link = wsLink({
	client: createWSClient({
		keepAlive: {
			enabled: false,
			intervalMs: 5000,
			pongTimeoutMs: 5000,
		},
		retryDelayMs: (attempt) => {
			return Math.min(10_000, 1000 * Math.pow(2, attempt))
		},
		url: wsUrl,
		onError: (error) => {
			console.error(error)
			globalToast$.next({
				title: 'An error occurred while communicating with the server. Try refreshing the page.',
				variant: 'destructive',
			})
		},
		onClose: (error) => {
			console.log('WebSocket connection closed: ', JSON.stringify(error))
			defaultStore.set(trpcConnectedAtom, false)
		},
		onOpen: () => {
			defaultStore.set(trpcConnectedAtom, true)
			console.log('WebSocket connection opened')
		},
	}),
	transformer: superjson,
})

export const links = [link]

export const reactQueryClient = new QueryClient()

export const trpc = createTRPCClient<AppRouter>({ links })

// @ts-expect-error binding to window for debugging
window.trpc = trpc

export function hashQueryKey(queryKey: any): string {
	return superjson.stringify(queryKey)
}
