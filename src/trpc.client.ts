import * as AR from '@/app-routes'
import { globalToast$ } from '@/hooks/use-global-toast'
import type { PublicConfig } from '@/server/config'
import type { AppRouter } from '@/server/router'
import * as ConfigClient from '@/systems.client/config.client'
import * as FeatureFlags from '@/systems.client/feature-flags'
import * as ReactRx from '@react-rxjs/core'
import { createSignal } from '@react-rxjs/utils'
import { QueryClient } from '@tanstack/react-query'
import { createTRPCClient, createWSClient, loggerLink, wsLink } from '@trpc/client'
import superjson from 'superjson'
import * as Zus from 'zustand'
import { sleep } from './lib/async'
import { formatVersion } from './lib/versioning'

const wsHostname = window.location.origin.replace(/^http/, 'ws').replace(/\/$/, '')
const wsUrl = `${wsHostname}${AR.route('/trpc')}`

const [_trpcConnected$, setTrpcConnected] = createSignal<boolean>()
export const [useTrpcConnected, trpcConnected$] = ReactRx.bind(_trpcConnected$, false)
trpcConnected$.subscribe()
let previousConnections = false
let attempt = 0
let previousConfig: PublicConfig | undefined
const wsClient = createWSClient({
	keepAlive: {
		enabled: false,
		intervalMs: 5000,
		pongTimeoutMs: 5000,
	},
	retryDelayMs: () => {
		const delay = Math.max(1_000, 1000 * Math.pow(2, attempt))
		attempt++
		return delay
	},
	url: wsUrl,
	onError: async (error) => {
		console.error(error)
		globalToast$.next({
			title: 'An error occurred while communicating with the server. Try refreshing the page.',
			variant: 'destructive',
		})

		if (attempt > 5) {
			const res = await fetch(AR.link('/check-auth'))
			if (!res.ok) {
				window.location.reload()
			}
		}
	},
	onClose: async (error) => {
		console.error('WebSocket connection closed: ', JSON.stringify(error))
		setTrpcConnected(false)
		if (attempt > 5) {
			const res = await fetch(AR.link('/check-auth'))
			if (!res.ok) {
				window.location.reload()
			}
		}
	},
	onOpen: async () => {
		setTrpcConnected(true)
		console.log('WebSocket connection opened')
		if (previousConnections) ConfigClient.invalidateConfig()
		previousConnections = true
		const config = await ConfigClient.fetchConfig()
		attempt = 0

		// -------- version skew protection --------
		if (previousConfig && previousConfig.PUBLIC_GIT_SHA !== config.PUBLIC_GIT_SHA) {
			globalToast$.next({ variant: 'info', title: 'SLM is being upgraded, window will refresh shortly...' })
			await sleep(500)
			const buildFormatted = formatVersion(previousConfig.PUBLIC_GIT_BRANCH, previousConfig.PUBLIC_GIT_SHA)
			const configFormatted = formatVersion(config.PUBLIC_GIT_BRANCH, config.PUBLIC_GIT_SHA)
			console.warn(`Version skew detected (${buildFormatted} -> ${configFormatted}), reloading window`)
			window.location.reload()
		} else if (!previousConfig) {
			console.log(
				`%cSLM version ${formatVersion(config.PUBLIC_GIT_BRANCH, config.PUBLIC_GIT_SHA)}`,
				'color: limegreen',
			)
			previousConfig = config
		} else {
			reactQueryClient.invalidateQueries()
		}
	},
})

export const links = [
	loggerLink({ enabled: () => !!FeatureFlags.get('trpcLogs') }),
	wsLink<AppRouter>({
		client: wsClient,
		transformer: superjson,
	}),
]

export const reactQueryClient = new QueryClient()

export const trpc = createTRPCClient<AppRouter>({ links })

// @ts-expect-error binding to window for debugging
window.trpc = trpc

export function hashQueryKey(queryKey: any): string {
	return superjson.stringify(queryKey)
}
