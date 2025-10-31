import * as AR from '@/app-routes'
import { globalToast$ } from '@/hooks/use-global-toast'
import type { PublicConfig } from '@/server/config'
import type { OrpcAppRouter } from '@/server/router'
import * as ConfigClient from '@/systems.client/config.client'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import { RouterClient } from '@orpc/server'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import * as ReactRx from '@react-rxjs/core'
import { QueryClient } from '@tanstack/react-query'
import { WebSocket } from 'partysocket'
import * as Rx from 'rxjs'
import { sleep } from './lib/async'
import { formatVersion } from './lib/versioning'

const wsHostname = window.location.origin.replace(/^http/, 'ws').replace(/\/$/, '')
const wsUrl = `${wsHostname}${AR.route('/orpc')}`
const websocket = new WebSocket(wsUrl)

const orpcLink = new RPCLink({
	websocket,
	clientInterceptors: [],
})

const _orpcClient: RouterClient<OrpcAppRouter> = createORPCClient(orpcLink)

const opened$ = Rx.fromEvent(websocket, 'open').pipe(Rx.retry())
const closed$ = Rx.fromEvent(websocket, 'close').pipe(Rx.retry())
const error$ = Rx.fromEvent(websocket, 'error').pipe(Rx.retry())

let previousConnections = false
let previousConfig: PublicConfig | undefined

// this whole thing is probably just paranoia
const connectedCold$ = Rx.merge([
	Rx.of(!!websocket.OPEN),
	opened$.pipe(Rx.map(() => !!websocket.OPEN)),
	closed$.pipe(Rx.map(() => !!websocket.OPEN)),
	error$.pipe(Rx.map(() => !!websocket.OPEN)),
])
	.pipe(Rx.distinctUntilChanged(), Rx.switchMap((open) => open ? Rx.of(true) : Rx.of(false).pipe(Rx.delay(1000))))

export const [useConnected, connected$] = ReactRx.bind(connectedCold$, false)

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
			queryClient.invalidateQueries()
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

export const queryClient = new QueryClient()
export const orpc = createTanstackQueryUtils(_orpcClient, { path: ['orpc'] })
