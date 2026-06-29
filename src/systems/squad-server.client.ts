import { globalToast$ } from '@/hooks/use-global-toast'
import * as CHAT from '@/models/chat.models'
import * as MH from '@/models/match-history.models'
import * as SquadServer from '@/models/squad-server.models'
import * as SM from '@/models/squad.models'
import * as RPC from '@/orpc.client'
import * as Cookies from '@/systems/app-routes.client'
import * as ConfigClient from '@/systems/config.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
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

const chatDisconnected$ = new Rx.Subject<CHAT.ConnectionErrorEvent>()
let previouslyConnected = false

export const chatEvent$ = RPC.observe(
	() => {
		const eventBuffer = ChatStore.getState().chatState.eventBuffer
		const serverId = ChatStore.getState().loadedServerId ?? SelectedServerStore.getState().selectedServerId
		return RPC.orpc.squadServer.watchChatEvents.call({ lastEventId: eventBuffer[eventBuffer.length - 1]?.id, serverId: serverId })
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
).pipe(Rx.tap({ next: () => (previouslyConnected = true) }), Rx.share())

export const ChatStore = Zus.createStore<SquadServer.ChatStore>((set, get) => {
	return {
		chatState: CHAT.getInitialChatState(),
		loadedServerId: null,
		secondaryFilterState: 'DEFAULT',
		eventGeneration: 0,
		selectedMatchOrdinal: null,
		setSecondaryFilterState(state) {
			set({ secondaryFilterState: state })
		},
		async setSelectedMatchOrdinal(ordinal) {
			const currentMatch = await MatchHistoryClient.currentMatch$().getValue()
			set({ selectedMatchOrdinal: currentMatch?.ordinal === ordinal ? null : ordinal })
		},
		handleChatEvents(events) {
			const config = ConfigClient.getConfig()
			set(state => {
				let chatState = state.chatState
				// this is done to cache break the selectors
				chatState.interpolatedState = CHAT.InterpolableState.clone(chatState.interpolatedState)
				let loadedServerId = state.loadedServerId
				for (const event of events) {
					if (event.type === 'INIT') {
						loadedServerId = event.serverId
					}
					CHAT.handleEvent(chatState, event, config?.chat)
				}
				return { chatState, eventGeneration: state.eventGeneration + 1, loadedServerId }
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

export function useWarnPlayerMutation() {
	return useMutation({
		mutationFn: async (input: { playerId: string; reason: string }) => {
			return RPC.orpc.squadServer.warnPlayer.call(input)
		},
	})
}

export function useDemoteCommanderMutation() {
	return useMutation({
		mutationFn: async (playerId: string) => {
			return RPC.orpc.squadServer.demoteCommander.call({ playerId })
		},
	})
}

export function useDisbandSquadMutation() {
	return useMutation({
		mutationFn: async (input: { teamId: 1 | 2; squadId: number }) => {
			return RPC.orpc.squadServer.disbandSquad.call(input)
		},
	})
}

export function useRemoveFromSquadMutation() {
	return useMutation({
		mutationFn: async (playerId: string) => {
			return RPC.orpc.squadServer.removeFromSquad.call({ playerId })
		},
	})
}

type PlayerSelectionStore = {
	selection: Record<string, boolean>
	setSelection: (updater: Record<string, boolean> | ((old: Record<string, boolean>) => Record<string, boolean>)) => void
	selectSquad: (playerId: SM.PlayerId) => void
}

export const PlayerSelectionStore = Zus.createStore<PlayerSelectionStore>((set, get) => ({
	selection: {},
	setSelection: (updater) => {
		const next = typeof updater === 'function' ? updater(get().selection) : updater
		set({ selection: next })
	},
	selectSquad: (playerId) => {
		const players = SquadServer.Select.chatState(ChatStore.getState()).players
		const player = SM.PlayerIds.find(players, p => p.ids, playerId)
		if (!player?.squadId || !player.teamId) return
		const squadIds = players
			.filter(p => p.squadId === player.squadId && p.teamId === player.teamId)
			.map(p => SM.PlayerIds.getPlayerId(p.ids))
		set({ selection: Object.fromEntries(squadIds.map(id => [id, true])) })
	},
}))

type SelectedServerStore = {
	selectedServerId: string
	setSelectedServer: (serverId: string) => Promise<void>
	setAsDefaultServer: () => void
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
	layersStatus$.subscribe()
	serverRolling$.subscribe()
	Rx.merge(chatEvent$, chatDisconnected$.pipe(Rx.map(e => [e]))).subscribe(events => {
		ChatStore.getState().handleChatEvents(events as (CHAT.Event | CHAT.LifecycleEvent)[])
	})

	// this cookie will always be set correctly according to the path on page load, which is the only time we expect setup() to be called
	const cookieServerId = Cookies.getCookie('default-server-id')!

	SelectedServerStore = Zus.createStore((set, get) => ({
		selectedServerId: cookieServerId,
		setSelectedServer: async (serverId: string) => {
			if (serverId === get().selectedServerId) return
			const res = await RPC.orpc.squadServer.setSelectedServer.call(serverId)
			if (res.code !== 'ok') {
				globalToast$.next({ variant: 'destructive', title: res.code })
				return
			}

			Cookies.setCookie('default-server-id', serverId)
			return set({ selectedServerId: serverId })
		},
		setAsDefaultServer: () => {
			Cookies.setCookie('default-server-id', get().selectedServerId)
		},
	}))

	return SelectedServerStore
}
