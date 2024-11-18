import { createTRPCClient } from '@trpc/client'
import { createTRPCReact, createWSClient, wsLink } from '@trpc/react-query'
import { createTRPCJotai } from 'jotai-trpc'
import superjson from 'superjson'

import * as AR from '@/app-routes'
import type { AppRouter } from '@/server/router'

const wsHostname = window.location.origin.replace(/^http/, 'ws').replace(/\/$/, '')
const wsUrl = `${wsHostname}${AR.exists('/trpc')}`
export const links = [
	wsLink({
		client: createWSClient({ url: wsUrl }),
		transformer: { input: superjson, output: superjson },
	}),
]
export const trpc = createTRPCClient<AppRouter>({ links })
export const trpcJotai = createTRPCJotai<AppRouter>({ links })
export const trpcReact = createTRPCReact<AppRouter>()
