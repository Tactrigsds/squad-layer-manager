import { createTRPCClient } from '@trpc/client'
import { createTRPCReact, createWSClient, wsLink } from '@trpc/react-query'
import { UndefinedInitialDataOptions, useQuery } from '@tanstack/react-query'
import { globalToast$ } from '@/hooks/use-global-toast'

import superjson from 'superjson'

import * as AR from '@/app-routes'
import type { AppRouter } from '@/server/router'
import React from 'react'

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
		}),
		transformer: superjson,
	}),
]

export const trpc = createTRPCClient<AppRouter>({ links })

/**
 * @deprecated bad library, phase this out. doesn't handle transports well and a bug in its subscription implementation caused me great pain
 */
export const trpcReact = createTRPCReact<AppRouter>()

export function hashQueryKey(queryKey: any): string {
	return superjson.stringify(queryKey)
}
