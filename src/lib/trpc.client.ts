import { createTRPCClient } from '@trpc/client'
import { createTRPCReact, createWSClient, wsLink } from '@trpc/react-query'
import { UndefinedInitialDataOptions, useQuery } from '@tanstack/react-query'
import superjson from 'superjson'

import * as AR from '@/app-routes'
import type { AppRouter } from '@/server/router'
import React from 'react'

const wsHostname = window.location.origin.replace(/^http/, 'ws').replace(/\/$/, '')
const wsUrl = `${wsHostname}${AR.exists('/trpc')}`
export const links = [
	wsLink({
		client: createWSClient({ url: wsUrl }),
		transformer: superjson,
	}),
]

export const trpc = createTRPCClient<AppRouter>({ links })
export const trpcReact = createTRPCReact<AppRouter>()

export function hashQueryKey(queryKey: any): string {
	return superjson.stringify(queryKey)
}
