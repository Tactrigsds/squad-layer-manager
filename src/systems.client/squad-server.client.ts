import * as AR from '@/app-routes'
import { coldOrpcSubscription, distinctDeepEquals } from '@/lib/async'
import * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import * as RPC from '@/orpc.client'
import { ServerEntry } from '@/server/config'
import * as AppRoutesClient from '@/systems.client/app-routes.client'
import * as Cookies from '@/systems.client/app-routes.client'
import * as ConfigClient from '@/systems.client/config.client'
import * as ReactRx from '@react-rxjs/core'
import { useMutation } from '@tanstack/react-query'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'

// TODO we probably don't need to "bind" multiple observables like this. we should create some helper "derive" which lets us derive one state observable from another
export const [useLayersStatus, layersStatus$] = ReactRx.bind<SM.LayersStatusResExt>(
	coldOrpcSubscription(() => RPC.orpc.squadServer.watchLayersStatus.call()),
)
export const [useServerInfoRes, serverInfoRes$] = ReactRx.bind<SM.ServerInfoRes>(
	coldOrpcSubscription(() => RPC.orpc.squadServer.watchServerInfo.call()),
)
export const [useServerInfo, serverInfo$] = ReactRx.bind<SM.ServerInfo | null>(
	serverInfoRes$.pipe(
		Rx.map(res => res.code === 'ok' ? res.data : null),
	),
	null,
)

export const [useServerRolling, serverRolling$] = ReactRx.bind<boolean>(
	coldOrpcSubscription(() => RPC.orpc.squadServer.watchServerRolling.call()),
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
			return RPC.orpc.squadServer.endMatch.call()
		},
	})
}

export function useDisableFogOfWarMutation() {
	return useMutation({
		mutationFn: async () => {
			return RPC.orpc.squadServer.toggleFogOfWar.call({ disabled: true })
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
	serverRolling$.subscribe()

	// this cookie will always be set correctly according to the path on page load, which is the only time we expect setup() to be called
	const serverId = Cookies.getCookie('default-server-id')!

	selectedServerStore = Zus.createStore((set) => ({
		selectedServerId: serverId,
		setSelectedServer: async (serverId: string) => {
			return set({ selectedServerId: serverId })
		},
	}))

	// -------- persist selected server id according to navigation, and inform backend of any changes --------
	//
	Rx.merge(
		AppRoutesClient.route$,
		// when this window is the last focused it should decide what server is selected for new tabs
		Rx.fromEvent(window, 'focus').pipe(Rx.map(() => AR.resolveRoute(window.location.pathname))),
	).subscribe((route) => {
		const state = selectedServerStore.getState()
		if (!route || route.id !== '/servers/:id' || route.params.id === state.selectedServerId) return

		Cookies.setCookie('default-server-id', route.params.id)
		void RPC.orpc.squadServer.setSelectedServer.call(route.params.id)
		state.setSelectedServer(route.params.id)
	})

	return selectedServerStore
}
