import * as AR from '@/app-routes'

import { distinctDeepEquals } from '@/lib/async'
import * as CHAT from '@/models/chat.models'
import type * as MH from '@/models/match-history.models'
import type * as SM from '@/models/squad.models'
import * as RPC from '@/orpc.client'
import * as Cookies from '@/systems.client/app-routes.client'
import * as ConfigClient from '@/systems.client/config.client'
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

export const [useServerRolling, serverRolling$] = ReactRx.bind<number | null>(
	RPC.observe(() => RPC.orpc.squadServer.watchServerRolling.call()),
)

export const [useCurrentMatch, currentMatch$] = ReactRx.bind<MH.MatchDetails | null>(
	layersStatus$.pipe(
		Rx.map(res => res.code === 'ok' && res.data.currentMatch ? res.data.currentMatch : null),
		distinctDeepEquals(),
	),
	null,
)

const chatDisconnected$ = new Rx.Subject<CHAT.ConnectionErrorEvent>()
let previouslyConnected = false
export const [useChatEvents, chatEvent$] = ReactRx.bind(
	RPC.observe(
		() => {
			const eventBuffer = ChatStore.getState().chatState.eventBuffer
			return RPC.orpc.squadServer.watchChatEvents.call({ lastEventId: eventBuffer[eventBuffer.length - 1]?.id })
		},
		{
			onError: () => {
				chatDisconnected$.next({
					type: 'CONNECTION_ERROR',
					code: previouslyConnected ? 'CONNECTION_LOST' : 'RECONNECT_FAILED',
					time: Date.now(),
				})
			},
		},
	).pipe(Rx.tap({ next: () => (previouslyConnected = true) })),
)

type ChatStore = {
	chatState: CHAT.ChatState
	eventFilterState: CHAT.EventFilterState
	setEventFilterState(state: CHAT.EventFilterState): void
	handleChatEvents(event: (CHAT.Event | CHAT.SyncedEvent | CHAT.ConnectionErrorEvent)[]): void
}

export const ChatStore = Zus.createStore<ChatStore>((set, get) => {
	return {
		chatState: CHAT.INITIAL_CHAT_STATE,
		eventFilterState: 'ALL',
		setEventFilterState(state) {
			set({ eventFilterState: state })
		},
		handleChatEvents(events) {
			const config = ConfigClient.getConfig()
			set(state => {
				let chatState = state.chatState
				chatState = {
					interpolatedState: CHAT.InterpolableState.clone(chatState.interpolatedState),
					synced: chatState.synced,

					savepoints: [...chatState.savepoints],
					eventBuffer: [...chatState.eventBuffer],
					rawEventBuffer: [...chatState.rawEventBuffer],
				}
				for (const event of events) {
					if (chatState.synced || event.type === 'SYNCED') console.info('event ', event.type, event)
					CHAT.handleEvent(chatState, event, config?.chat)
				}
				return { chatState }
			})
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

export function usePlayerCount() {
	return Zus.useStore(
		ChatStore,
		state => (state.chatState.synced && !state.chatState.connectionError) ? state.chatState.interpolatedState.players.length : null,
	)
}

export function setup() {
	serverInfoRes$.subscribe()
	currentMatch$.subscribe()
	serverRolling$.subscribe()
	Rx.merge(chatEvent$, chatDisconnected$.pipe(Rx.map(e => [e]))).subscribe(events => {
		ChatStore.getState().handleChatEvents(events as (CHAT.Event | CHAT.ConnectionErrorEvent | CHAT.SyncedEvent)[])
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
