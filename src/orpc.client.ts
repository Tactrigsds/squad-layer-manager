import * as AR from '@/app-routes'
import * as RxHelpers from '@/lib/react-rxjs-helpers'
import { toast } from '@/lib/toast'
import * as ZusUtils from '@/lib/zustand'
import * as SM from '@/models/squad.models'
import type { OrpcAppRouter } from '@/server/orpc-app-router'
import * as ConfigClient from '@/systems/config.client'
import { createORPCClient, onError } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import type { RouterClient } from '@orpc/server'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import * as ReactRx from '@react-rxjs/core'
import { onlineManager, QueryClient } from '@tanstack/react-query'
import { WebSocket } from 'partysocket'
import * as Rx from 'rxjs'
import { toCold, traceTag } from './lib/async'
import { formatVersion } from './lib/versioning'

const wsHostname = window.location.origin.replace(/^http/, 'ws').replace(/\/$/, '')
const wsUrl = `${wsHostname}${AR.route('/orpc')}`

// On reconnect, tell the server the id we last held so it reclaims that exact presence entry (activity +
// locks) and evicts our stale socket, instead of minting a fresh id and leaving a ghost that reads as an
// "other active session". partysocket re-invokes this per connect; empty on the first connect (no id yet).
function resolveWsUrl(): string {
	const priorClientId = ConfigClient.getConfig()?.wsClientId
	return priorClientId ? `${wsUrl}?prior=${encodeURIComponent(priorClientId)}` : wsUrl
}
const websocket = new WebSocket(resolveWsUrl)

// read off the socket rather than connectStatus$, because a close event fails the in-flight calls and moves the status
// in an order we don't control: readyState is already CLOSING/CLOSED by the time those rejections land.
function transportOpen() {
	return websocket.readyState === WebSocket.OPEN
}

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
			// a dropped socket fails every in-flight call at once, and none of those failures tell the user anything the
			// reconnect toast isn't already saying. Only calls that failed while the transport was up are real news.
			if (!transportOpen()) return
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

// tanstack's own notion of "online" is navigator.onLine, which stays true when our websocket is the only thing that
// died. Driving it off the socket instead means queries and mutations pause for the outage and resume on reconnect,
// rather than each one burning its retries against a transport that cannot answer.
//
// Only a sustained outage counts as offline. 'pending' is a socket that has never opened yet, and reporting that as
// offline would pause every query on the initial page load: tanstack only un-pauses a query when it is both online
// AND the document is visible (see canContinue in its retryer), and it notifies on change, so a load that goes
// offline -> online while the page is hidden leaves those queries paused for good. The link buffers calls made
// before the socket opens anyway, so there is nothing to pause for here.
connectStatus$.pipe(
	Rx.map(status => status !== 'closed'),
	Rx.distinctUntilChanged(),
).subscribe(online => onlineManager.setOnline(online))

// A backgrounded tab's socket is dropped externally (OS suspension, network sleep, a proxy idle-timeout) while nothing
// on either side keeps it alive. partysocket has no liveness detection, so the dead socket only surfaces as a close
// event around the moment the tab is refocused, and its first reconnect attempt then waits minReconnectionDelay (1-5s).
// On refocus we force an immediate reconnect (resets partysocket's retry backoff to 0), so recovery is near-instant.
let becameVisibleAt = document.hidden ? 0 : Date.now()
document.addEventListener('visibilitychange', () => {
	if (document.hidden) return
	becameVisibleAt = Date.now()
	if (!transportOpen()) websocket.reconnect()
})

// A disconnect discovered at or just after refocus is the expected idle-drop, and it recovers on its own within a
// second or two, so warning about it is just noise. This grace window suppresses the toast for that case while still
// reporting a genuine outage that happens (or persists) while the user is actively looking at the tab.
const REFOCUS_GRACE_MS = 3_000
const shouldWarnDisconnected$ = Rx.combineLatest([
	connectStatus$,
	Rx.fromEvent(document, 'visibilitychange').pipe(Rx.startWith(null)),
]).pipe(
	Rx.switchMap(([status]) => {
		if (status !== 'closed' || document.hidden) return Rx.of(false)
		const remaining = REFOCUS_GRACE_MS - (Date.now() - becameVisibleAt)
		if (remaining <= 0) return Rx.of(true)
		return Rx.concat(Rx.of(false), Rx.of(true).pipe(Rx.delay(remaining)))
	}),
	Rx.distinctUntilChanged(),
)

// one toast for the whole outage, replaced in place by its own resolution. Keyed so repeated close events can't stack
// copies of it, and unclearable because dismissing it wouldn't make the app usable again.
const RECONNECT_TOAST_ID = 'ws-reconnect'
let reconnectToastShown = false
shouldWarnDisconnected$.subscribe(warn => {
	if (warn && !reconnectToastShown) {
		reconnectToastShown = true
		// the whole state is in the title: updating a toast by id merges into the existing one, so a description set
		// here would survive into the success toast that replaces it
		toast.loading('Lost connection to the server, reconnecting...', {
			id: RECONNECT_TOAST_ID,
			duration: Infinity,
			dismissible: false,
		})
	} else if (!warn && reconnectToastShown) {
		reconnectToastShown = false
		// resolved because we reconnected -> tell the user; resolved because the tab went hidden while still down ->
		// just drop the toast, there is nothing to celebrate and no one watching
		if (transportOpen()) {
			toast.success('Reconnected to the server', { id: RECONNECT_TOAST_ID, duration: 3_000, dismissible: true })
		} else {
			toast.dismiss(RECONNECT_TOAST_ID)
		}
	}
})

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

// tanstack's default key hash is JSON.stringify, which throws on the discord ids we pass as query inputs.
// mirrors its key sorting so hashes stay stable regardless of property order. see hashKey in query-core
function hashQueryKey(queryKey: readonly unknown[]): string {
	return JSON.stringify(queryKey, (_, val) => {
		if (typeof val === 'bigint') return `${val}n`
		if (typeof val !== 'object' || val === null || Array.isArray(val)) return val
		const proto = Object.getPrototypeOf(val)
		if (proto !== Object.prototype && proto !== null) return val
		return Object.keys(val).sort().reduce<Record<string, unknown>>((sorted, key) => {
			sorted[key] = (val as Record<string, unknown>)[key]
			return sorted
		}, {})
	})
}

export const queryClient = new QueryClient({ defaultOptions: { queries: { queryKeyHashFn: hashQueryKey } } })
ZusUtils.registerQueryClient(queryClient)
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
				// resubscribing over a socket that is down just fails again, so the retry waits for the transport to come
				// back instead of polling it. The reconnect itself is the delay, and the reconnect toast is the report.
				const untilOpen$ = connectStatus$.pipe(Rx.filter(status => status === 'open'), Rx.take(1))
				if (!transportOpen()) return untilOpen$

				// every watch subscription in the app retries at once after a reconnect, so identical delays would
				// thunder against the server. Half-jittered, capped exponential backoff.
				const backoffMs = Math.min(Math.pow(2, count) * 250, MAX_RETRY_DELAY)
				const backoff$ = Rx.timer(backoffMs / 2 + Math.random() * (backoffMs / 2))

				console.error(`[${tag}] subscription failed (attempt ${count})`, error)
				if (count > 2) {
					// keyed per subscription so a stuck one replaces its own toast rather than stacking a new one each attempt
					toast.error('Remote Subscription Error', { id: `sub-error-${tag}`, description: `${tag}: ${error.message}` })
				}

				// the socket can still drop during the backoff, so hold there too rather than retrying into a dead transport
				return backoff$.pipe(Rx.concatMap(() => untilOpen$))
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
