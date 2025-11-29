import * as AR from '@/app-routes'
import { distinctDeepEquals } from '@/lib/async'

import * as CHAT from '@/models/chat.models'
import type * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import * as RPC from '@/orpc.client'
import * as Cookies from '@/systems.client/app-routes.client'
import * as ReactRx from '@react-rxjs/core'
import { useMutation } from '@tanstack/react-query'
import * as Im from 'immer'
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

export const [useServerRolling, serverRolling$] = ReactRx.bind<Date | null>(
	RPC.observe(() => RPC.orpc.squadServer.watchServerRolling.call()),
)

export const [useCurrentMatch, currentMatch$] = ReactRx.bind<MH.MatchDetails | null>(
	layersStatus$.pipe(
		Rx.map(res => res.code === 'ok' && res.data.currentMatch ? res.data.currentMatch : null),
		distinctDeepEquals(),
	),
	null,
)

export const [useChatEvents, chatEvent$] = ReactRx.bind(RPC.observe(() => RPC.orpc.squadServer.watchChatEvents.call()))

type ChatStore = {
	chatState: CHAT.ChatState
	eventFilterState: CHAT.EventFilterState
	setEventFilterState(state: CHAT.EventFilterState): void
	handleChatEvent(event: (CHAT.Event | CHAT.SyncedEvent)[]): void
}

export const ChatStore = Zus.createStore<ChatStore>((set, get) => {
	return {
		chatState: CHAT.INITIAL_CHAT_STATE,
		eventFilterState: 'ALL',
		setEventFilterState(state) {
			set({ eventFilterState: state })
		},
		handleChatEvent(_events) {
			let events = Array.isArray(_events) ? _events : [_events]
			set(Im.produce<ChatStore>(draft => {
				for (const event of events) {
					if (draft.chatState.synced || event.type === 'SYNCED') console.log('event ', event.type, event)
					const res = CHAT.handleEvent(draft.chatState, event)
					if (!draft.chatState.synced) continue
					if (res?.code === 'ok:rollback') {
						console.log(res.message)
					}
					if (res?.code) {
						for (const interped of res.interpolated) {
							if (interped.type !== 'NOOP') continue
							console.warn(`handled ${interped.originalEvent.type} as noop: ${interped.reason}`, event)
						}
					}
				}
			}))
		},
	}
})

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
	chatEvent$.subscribe(event => {
		ChatStore.getState().handleChatEvent(event)
	})

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
