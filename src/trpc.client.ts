import { globalToast$ } from '@/hooks/use-global-toast'
import * as ConfigClient from '@/systems.client/config.client'
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import { formatVersion } from './lib/versioning'

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
		onOpen: async () => {
			defaultStore.set(trpcConnectedAtom, true)
			console.log('WebSocket connection opened')
			reactQueryClient.invalidateQueries()
			const config = await ConfigClient.fetchConfig()

			const buildGitBranch = import.meta.env.PUBLIC_GIT_BRANCH ?? 'unknown'
			const buildGitSha = import.meta.env.PUBLIC_GIT_SHA ?? 'unknown'
			// -------- version skew protection --------
			//  This only works as long as index.html is resolved directly from fastify and not cached.
			if ((config.PUBLIC_GIT_BRANCH !== buildGitBranch) || config.PUBLIC_GIT_SHA !== buildGitSha) {
				console.warn(
					`Version skew detected (${formatVersion(buildGitBranch, buildGitSha)} -> ${
						formatVersion(config.PUBLIC_GIT_BRANCH, config.PUBLIC_GIT_SHA)
					})`,
				)
				console.warn('reloading window')
				window.location.reload()
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
