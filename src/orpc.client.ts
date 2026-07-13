import * as AR from '@/app-routes'
import * as RxHelpers from '@/lib/react-rxjs-helpers'
import { toast } from '@/lib/toast'
import * as SM from '@/models/squad.models'
import type { OrpcAppRouter } from '@/server/orpc-app-router'
import * as ConfigClient from '@/systems/config.client'
import { createORPCClient, onError } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import type { RouterClient } from '@orpc/server'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import * as ReactRx from '@react-rxjs/core'
import { QueryClient } from '@tanstack/react-query'
import { WebSocket } from 'partysocket'
import * as Rx from 'rxjs'
import { toCold, traceTag } from './lib/async'
import { formatVersion } from './lib/versioning'

const wsHostname = window.location.origin.replace(/^http/, 'ws').replace(/\/$/, '')
const wsUrl = `${wsHostname}${AR.route('/orpc')}`
const websocket = new WebSocket(wsUrl)

const orpcLink = new RPCLink({
	// partysocket's WebSocket is a drop-in replacement, but types its readyState as
	// `number` rather than the DOM WebSocket's `0 | 1 | 2 | 3` literal union that
	// RPCLink expects. Cast to bridge the (behaviorally compatible) gap.
	websocket: websocket as unknown as globalThis.WebSocket,
	clientInterceptors: [
		onError(error => {
			// AbortErrors happen whenever an unsubscribe happens, we can safely ignore them
			if (error instanceof Error && error.name === 'AbortError') return
			console.error(error)
			if (error instanceof Error) {
				toast.error('Transport Error', { description: error.message })
			} else {
				toast.error('Transport Error', { description: 'Unknown error' })
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

connectStatus$.subscribe()

// suspending state observables only get their first-emit clock while the websocket is actually up, so a
// disconnect keeps them in Suspense (resolving on reconnect) instead of erroring them out. see RxHelpers.bind
RxHelpers.setTransportLive(connectStatus$.pipe(Rx.map(status => status === 'open'), Rx.distinctUntilChanged()))

opened$.pipe(
	Rx.tap(() => {
		if (disconnectTime) {
			const reconnectionDuration = Date.now() - disconnectTime
			console.log(`WebSocket reconnected to ${wsUrl} (took ${reconnectionDuration}ms)`)
			disconnectTime = undefined
		} else {
			console.log('WebSocket connection opened to ' + wsUrl)
		}
		if (previousConnections) void queryClient.invalidateQueries()
		previousConnections = true
	}),
	Rx.retry(),
).subscribe()

// -------- version skew protection --------
let previousSha: string | undefined
ConfigClient.Store.subscribe(config => {
	if (!config) return
	if (!previousSha) {
		previousSha = config.PUBLIC_GIT_SHA
		console.log(`%cSLM version ${formatVersion(config.PUBLIC_GIT_BRANCH, config.PUBLIC_GIT_SHA)}`, 'color: limegreen')
	} else if (previousSha !== config.PUBLIC_GIT_SHA) {
		toast.info('SLM is being upgraded, window will refresh shortly...')
		setTimeout(async () => {
			console.warn(`Version skew detected (${previousSha} -> ${config.PUBLIC_GIT_SHA}), reloading window`)
			window.location.reload()
		}, 500)
	}
})

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

const MAX_RETRY_DELAY = 10_000

/**
 * @param tag - identifies the subscription in logs, traces and error messages. Conventionally the router path,
 * e.g. 'squadServer.watchTickRate'.
 */
export function observe<T>(
	tag: string,
	task: () => Promise<Rx.ObservableInput<T>>,
	opts?: { onError?: (error: any, count: number) => void },
) {
	return Rx.from(toCold(task)).pipe(
		traceTag(`ORPC_${tag.replace(/[^0-9a-zA-Z_$]/g, '_')}`),
		Rx.concatAll(),
		Rx.retry({
			// without this the attempt count accumulates across the whole session, so a subscription that has
			// weathered a dozen reconnects ends up waiting tens of minutes before its next attempt
			resetOnSuccess: true,
			delay: (error, count) => {
				opts?.onError?.(error, count)
				// every watch subscription in the app retries at once after a reconnect, so identical delays would
				// thunder against the server. Half-jittered, capped exponential backoff.
				const backoffMs = Math.min(Math.pow(2, count) * 250, MAX_RETRY_DELAY)
				const backoff$ = Rx.timer(backoffMs / 2 + Math.random() * (backoffMs / 2))

				// we only want to log the error if the connection is closed
				if (connectStatus$.getValue() !== 'open') return backoff$

				console.error(`[${tag}] subscription failed (attempt ${count})`, error)
				if (count > 2) {
					toast.error('Remote Subscription Error', { description: `${tag}: ${error.message}` })
				}

				return backoff$
			},
		}),
	)
}

/**
 * Drops the err:server-not-loaded value every per-server stream can emit (see SquadServer.sliceStream$), so consumers
 * keep their original payload type. Losing the slice isn't this layer's problem to report: the dashboard gates itself on
 * squadServer.watchLoadedServers and swaps in the unavailable view, and the stream resumes on its own once the slice is
 * back. Holding rather than erroring is what makes that recovery automatic.
 */
export function dropServerNotLoaded<T>(): Rx.OperatorFunction<T | SM.ServerNotLoaded, T> {
	return Rx.filter((value): value is T => !SM.isServerNotLoaded(value))
}

/**
 * The query-side counterpart to dropServerNotLoaded: reads err:server-not-loaded as "no data". Every endpoint that can
 * return it is reachable only from the server dashboard, which unmounts itself when the server goes away, so the only
 * way a component sees this is a teardown race it is already on its way out of.
 */
export function selectLoaded<T>(res: T | SM.ServerNotLoaded): T | undefined {
	return SM.isServerNotLoaded(res) ? undefined : res
}
