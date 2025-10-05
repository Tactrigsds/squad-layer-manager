import * as AR from '@/app-routes'
import { distinctDeepEquals } from '@/lib/async'
import * as TrpcHelpers from '@/lib/trpc-helpers'
import * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import { ServerEntry } from '@/server/config'
import * as Cookies from '@/systems.client/app-routes.client'
import * as ConfigClient from '@/systems.client/config.client'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import { useMutation } from '@tanstack/react-query'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'

// TODO we probably don't need to "bind" multiple observables like this. we should create some helper "derive" which lets us derive one state observable from another
export const [useLayersStatus, layersStatus$] = ReactRx.bind<SM.LayersStatusResExt>(
	TrpcHelpers.fromTrpcSub(undefined, trpc.squadServer.watchLayersStatus.subscribe),
)
export const [useServerInfoRes, serverInfoRes$] = ReactRx.bind<SM.ServerInfoRes>(
	TrpcHelpers.fromTrpcSub(undefined, trpc.squadServer.watchServerInfo.subscribe),
)
export const [useServerInfo, serverInfo$] = ReactRx.bind<SM.ServerInfo | null>(
	serverInfoRes$.pipe(
		Rx.map(res => res.code === 'ok' ? res.data : null),
	),
	null,
)

export const [useCurrentMatch, currentMatch$] = ReactRx.bind<MH.MatchDetails | null>(
	layersStatus$.pipe(
		Rx.map(res => res.code === 'ok' && res.data.currentMatch ? res.data.currentMatch : null),
		distinctDeepEquals(),
	),
	null,
)

export function useEndMatch() {
	return useMutation({
		mutationFn: async () => {
			return trpc.squadServer.endMatch.mutate()
		},
	})
}

export function useDisableFogOfWarMutation() {
	return useMutation({
		mutationFn: async () => {
			return trpc.squadServer.toggleFogOfWar.mutate({ disabled: true })
		},
	})
}

type SelectedServerStore = {
	selectedServerId: string
	setSelectedServer: (serverId: string) => Promise<void>
}

let selectedServerStore!: Zus.StoreApi<SelectedServerStore>
export function useSelectedServerId() {
	return Zus.useStore(selectedServerStore, state => state.selectedServerId)
}

export function setup() {
	serverInfoRes$.subscribe()
	currentMatch$.subscribe()

	// this cookie will always be set correctly according to the path on page load, which is the only time we expect setup() to be called
	const serverId = Cookies.getCookie('default-server-id')!

	console.log('serverId', serverId)
	selectedServerStore = Zus.createStore((set) => ({
		selectedServerId: serverId,
		setSelectedServer: async (serverId: string) => {
			console.log('serverId', serverId)
			return set({ selectedServerId: serverId })
		},
	}))

	// -------- persist selected server id according to navigation, and inform backend of any changes --------
	// Create observable from MutationObserver to watch for URL changes
	const urlChanges$ = new Rx.Observable<void>(observer => {
		let lastPathname = window.location.pathname

		const mutationObserver = new MutationObserver(() => {
			if (window.location.pathname !== lastPathname) {
				lastPathname = window.location.pathname
				observer.next()
			}
		})

		// Observe changes to document body that might indicate navigation
		mutationObserver.observe(document.body, {
			childList: true,
			subtree: true,
		})

		return () => mutationObserver.disconnect()
	})

	Rx.merge(
		urlChanges$,
		// when this window is the last focused it should decide what server is selected for new tabs
		Rx.fromEvent(window, 'focus'),
	).subscribe((event) => {
		const state = selectedServerStore.getState()
		const route = AR.resolveRoute(window.location.pathname)
		if (!route || route.id !== '/servers/:id' || route.params.id === state.selectedServerId) return

		Cookies.setCookie('default-server-id', route.params.id)
		void trpc.squadServer.setSelectedServer.mutate(route.params.id)
		state.setSelectedServer(route.params.id)
	})

	return selectedServerStore
}
