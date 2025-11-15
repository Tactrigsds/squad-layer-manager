import * as AR from '@/app-routes'
import { distinctDeepEquals } from '@/lib/async'
import type * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import * as RPC from '@/orpc.client'
import * as Cookies from '@/systems.client/app-routes.client'
import * as ReactRx from '@react-rxjs/core'
import { useMutation } from '@tanstack/react-query'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'

// TODO we probably don't need to "bind" multiple observables like this. we should create some helper "derive" which lets us derive one state observable from another
export const [useLayersStatus, layersStatus$] = ReactRx.bind<SM.LayersStatusResExt>(
	RPC.observe(() => RPC.orpc.squadServer.watchLayersStatus.call()),
)
export const [useServerInfoRes, serverInfoRes$] = ReactRx.bind<SM.ServerInfoRes>(
	RPC.observe(() => RPC.orpc.squadServer.watchServerInfo.call()),
)
export const [useServerInfo, serverInfo$] = ReactRx.bind<SM.ServerInfo | null>(
	serverInfoRes$.pipe(
		Rx.map(res => res.code === 'ok' ? res.data : null),
	),
	null,
)

export const [useServerRolling, serverRolling$] = ReactRx.bind<boolean>(
	RPC.observe(() => RPC.orpc.squadServer.watchServerRolling.call()),
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

export let SelectedServerStore!: Zus.StoreApi<SelectedServerStore>
export function useSelectedServerId() {
	return Zus.useStore(SelectedServerStore, state => state.selectedServerId)
}

export function setup() {
	serverInfoRes$.subscribe()
	currentMatch$.subscribe()
	serverRolling$.subscribe()

	// this cookie will always be set correctly according to the path on page load, which is the only time we expect setup() to be called
	const cookieServerId = Cookies.getCookie('default-server-id')
	const route = AR.resolveRoute(window.location.pathname)
	const serverId = route?.id === '/servers/:id' ? route?.params.id : cookieServerId
	if (!serverId) throw new Error('No server id found')
	Cookies.setCookie('default-server-id', serverId)

	SelectedServerStore = Zus.createStore((set) => ({
		selectedServerId: serverId,
		setSelectedServer: async (serverId: string) => {
			Cookies.setCookie('default-server-id', serverId)
			return set({ selectedServerId: serverId })
		},
	}))

	return SelectedServerStore
}
