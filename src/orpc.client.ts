import * as AR from '@/app-routes'
import { globalToast$ } from '@/hooks/use-global-toast'
import type { PublicConfig } from '@/server/config'
import type { OrpcAppRouter } from '@/server/orpc-app-router'
import * as ConfigClient from '@/systems.client/config.client'
import { createORPCClient, onError } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import type { RouterClient } from '@orpc/server'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import * as ReactRx from '@react-rxjs/core'
import { QueryClient } from '@tanstack/react-query'
import { WebSocket } from 'partysocket'
import * as Rx from 'rxjs'
import { sleep, toCold, traceTag } from './lib/async'
import { formatVersion } from './lib/versioning'

const wsHostname = window.location.origin.replace(/^http/, 'ws').replace(/\/$/, '')
const wsUrl = `${wsHostname}${AR.route('/orpc')}`
const websocket = new WebSocket(wsUrl)

const orpcLink = new RPCLink({
	websocket,
	clientInterceptors: [
		onError(error => {
			// AbortErrors happen whenever an unsubscribe happens, we can safely ignore them
			if (error instanceof Error && error.name === 'AbortError') return
			console.error(error)
			if (error instanceof Error) {
				globalToast$.next({
					title: 'Transport Error',
					description: error.message,
					variant: 'destructive',
				})
			} else {
				globalToast$.next({
					title: 'Transport Error',
					description: 'Unknown error',
					variant: 'destructive',
				})
			}
		}),
	],
})

const _orpcClient: RouterClient<OrpcAppRouter> = createORPCClient(orpcLink)
websocket.addEventListener('close', () => {
	console.log('WebSocket close event')
})
websocket.addEventListener('error', () => {
	console.log('WebSocket error event')
})

const opened$ = Rx.fromEvent(websocket, 'open')
const closed$ = Rx.fromEvent(websocket, 'close')
const error$ = Rx.fromEvent(websocket, 'error')

let previousConnections = false
let previousConfig: PublicConfig | undefined
let disconnectTime: number | undefined

export type ConnectionStatus = 'open' | 'closed' | 'pending' | 'reconnecting'

export const [useConnectStatus, connectStatus$] = (() => {
	const connectStatusCold$: Rx.Observable<ConnectionStatus> = Rx.merge(
		Rx.of(websocket.readyState === WebSocket.OPEN ? 'open' as const : 'pending' as const).pipe(Rx.map(state => state as ConnectionStatus)),
		opened$.pipe(Rx.map(() => 'open' as const)),
		closed$.pipe(Rx.map(() => 'reconnecting' as const)),
	).pipe(
		Rx.distinctUntilChanged(),
		Rx.switchMap((status) => {
			if (status === 'reconnecting') return Rx.concat(Rx.of(status), Rx.of('closed' as const).pipe(Rx.delay(750))) // don't indicate there's anything wrong until we haven't been able to reconnect for a while
			return Rx.of(status)
		}),
	)

	return ReactRx.bind(connectStatusCold$, 'pending')
})()

opened$.pipe(
	Rx.concatMap(async () => {
		if (disconnectTime) {
			const reconnectionDuration = Date.now() - disconnectTime
			console.log(`WebSocket reconnected to ${wsUrl} (took ${reconnectionDuration}ms)`)
			disconnectTime = undefined
		} else {
			console.log('WebSocket connection opened to ' + wsUrl)
		}
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
			void queryClient.invalidateQueries()
		}
	}),
	Rx.retry(),
).subscribe()

error$.subscribe(() => {
	console.error('Websocket encountered an error')
})

closed$.pipe(
	Rx.concatMap(async (event: any) => {
		disconnectTime = Date.now()
		console.error(`WebSocket connection closed: ${event.code}, ${event.reason?.reason}`)
		if (websocket.retryCount > 5) {
			const res = await fetch(AR.link('/check-auth'))
			if (res.status === 401) {
				window.location.href = AR.link('/login')
			}
		}
	}),
).subscribe()

export const queryClient = new QueryClient()
export const orpc = createTanstackQueryUtils(_orpcClient, { path: ['orpc'] })

export function observe<T>(task: () => Promise<AsyncGenerator<T>>, opts?: { onError?: (error: any, count: number) => void }) {
	return Rx.from(toCold(task)).pipe(
		traceTag('ORPC_OBSERVE'),
		Rx.concatAll(),
		Rx.retry({
			delay: (error, count) => {
				opts?.onError?.(error, count)
				const backoff$ = Rx.timer(Math.pow(2, count) * 250)

				// we only want to log the error if the connection is closed
				if (connectStatus$.getValue() !== 'open') return backoff$

				console.error(error)
				if (count > 2) {
					globalToast$.next({
						title: 'Remote Subscription Error',
						description: error.message,
						variant: 'destructive',
					})
				}

				return backoff$
			},
		}),
	)
}
