import * as AR from '@/app-routes'
import { globalToast$ } from '@/hooks/use-global-toast'
import type { AppRouter } from '@/server/router'
import * as ConfigClient from '@/systems.client/config.client'
import * as ReactRx from '@react-rxjs/core'
import { createSignal } from '@react-rxjs/utils'
import { QueryClient } from '@tanstack/react-query'
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import { sleep } from './lib/async'
import { formatVersion } from './lib/versioning'

const wsHostname = window.location.origin.replace(/^http/, 'ws').replace(/\/$/, '')
const wsUrl = `${wsHostname}${AR.route('/trpc')}`

const [_trpcConnected$, setTrpcConnected] = createSignal<boolean>()
export const [useTrpcConnected, trpcConnected$] = ReactRx.bind(_trpcConnected$, false)
trpcConnected$.subscribe()

const link = wsLink<AppRouter>({
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
			setTrpcConnected(false)
		},
		onOpen: async () => {
			setTrpcConnected(true)
			console.log('WebSocket connection opened')
			ConfigClient.invalidateConfig()
			const config = await ConfigClient.fetchConfig()

			const buildGitBranch = import.meta.env.PUBLIC_GIT_BRANCH ?? 'unknown'
			const buildGitSha = import.meta.env.PUBLIC_GIT_SHA ?? 'unknown'
			// -------- version skew protection --------
			//  This only works as long as index.html is resolved directly from fastify and not cached.
			if (config.PUBLIC_GIT_SHA !== buildGitSha) {
				await sleep(1000)
				globalToast$.next({ variant: 'destructive', title: 'SLM is being upgraded, window will refresh shortly...' })
				const buildFormatted = formatVersion(buildGitBranch, buildGitSha)
				const configFormatted = formatVersion(config.PUBLIC_GIT_BRANCH, config.PUBLIC_GIT_SHA)
				console.warn(`Version skew detected (${buildFormatted} -> ${configFormatted}), reloading window`)
				window.location.reload()
			} else {
				reactQueryClient.invalidateQueries()
			}
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
