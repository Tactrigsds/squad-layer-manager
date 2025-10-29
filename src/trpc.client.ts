import * as AR from '@/app-routes'
import { globalToast$ } from '@/hooks/use-global-toast'
import type { PublicConfig } from '@/server/config'
import type { AppRouter } from '@/server/router'
import type { OrpcAppRouter } from '@/server/router'
import * as ConfigClient from '@/systems.client/config.client'
import * as FeatureFlags from '@/systems.client/feature-flags'
import { createORPCClient, onError } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import { ContractRouterClient } from '@orpc/contract'
import { RouterClient } from '@orpc/server'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import * as ReactRx from '@react-rxjs/core'
import { createSignal } from '@react-rxjs/utils'
import { QueryClient } from '@tanstack/react-query'
import { createTRPCClient, createWSClient, loggerLink, wsLink } from '@trpc/client'
import { WebSocket } from 'partysocket'
import * as Rx from 'rxjs'
import superjson from 'superjson'
import * as Zus from 'zustand'
import { sleep } from './lib/async'
import { formatVersion } from './lib/versioning'

const wsHostname = window.location.origin.replace(/^http/, 'ws').replace(/\/$/, '')
const wsUrl = `${wsHostname}${AR.route('/trpc')}`
const websocket = new WebSocket(wsUrl)

const orpcLink = new RPCLink({
	websocket,
	clientInterceptors: [],
})

export const orpc: RouterClient<OrpcAppRouter> = createORPCClient(orpcLink)

const opened$ = Rx.fromEvent(websocket, 'open')
const closed$ = Rx.fromEvent(websocket, 'close')
const error$ = Rx.fromEvent(websocket, 'error')

opened$.pipe(
	Rx.concatMap(async () => {
		console.log('WebSocket connection opened to ' + wsUrl)
		if (previousConnections) ConfigClient.invalidateConfig()
		previousConnections = true
		const config = await ConfigClient.fetchConfig()

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
	}),
	Rx.retry(),
).subscribe()

error$.subscribe(event => {
	console.error('Websocket encountered an error: ', event)
})

closed$.pipe(
	Rx.concatMap(async (event: Event) => {
		console.error('WebSocket connection closed: ', JSON.stringify(event))
		if (websocket.retryCount > 5) {
			const res = await fetch(AR.link('/check-auth'))
			if (!res.ok) {
				window.location.reload()
			}
		}
	}),
	Rx.retry(),
).subscribe()

const trpcConnectedCold$ = opened$.pipe(Rx.exhaustMap(() => Rx.concat(Rx.of(true), closed$.pipe(Rx.map(() => false)))))
export const [useTrpcConnected, trpcConnected$] = ReactRx.bind(trpcConnectedCold$, false)
trpcConnected$.subscribe()

let previousConnections = false
let previousConfig: PublicConfig | undefined
const wsClient = createWSClient({ url: wsUrl })

export const links = [
	loggerLink({ enabled: () => !!FeatureFlags.get('trpcLogs') }),
	wsLink<AppRouter>({
		client: wsClient,
		transformer: superjson,
	}),
]

export const reactQueryClient = new QueryClient()
export const reactQueryOrpcClient = createTanstackQueryUtils(orpc)

export const trpc = createTRPCClient<AppRouter>({ links })

// @ts-expect-error binding to window for debugging
window.trpc = trpc

export function hashQueryKey(queryKey: any): string {
	return superjson.stringify(queryKey)
}
