import * as SM from '@/models/squad.models'
import * as RPC from '@/orpc.client'
import * as Cookies from '@/systems/app-routes.client'
import * as ReactRx from '@react-rxjs/core'
import { useMutation } from '@tanstack/react-query'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'

// TODO we probably don't need to "bind" multiple observables like this. we should create some helper "derive" which lets us derive one state observable from another
export const [useLayersStatus, layersStatus$] = ReactRx.bind(
	(serverId: string) => RPC.observe(() => RPC.orpc.squadServer.watchLayersStatus.call({ serverId })),
)
export const [useServerInfoRes, serverInfoRes$] = ReactRx.bind(
	(serverId: string) => RPC.observe(() => RPC.orpc.squadServer.watchServerInfo.call({ serverId })),
)
export const [useServerInfo, serverInfo$] = ReactRx.bind(
	(serverId: string) =>
		serverInfoRes$(serverId).pipe(
			Rx.map(res => res.code === 'ok' ? res.data : null),
		),
)

export const [useServerRolling, serverRolling$] = ReactRx.bind(
	(serverId: string) => RPC.observe(() => RPC.orpc.squadServer.watchServerRolling.call({ serverId })),
)

export function useEndMatch() {
	return useMutation({
		mutationFn: async (serverId: string) => {
			return RPC.orpc.squadServer.endMatch.call({ serverId })
		},
	})
}

export function useDisableFogOfWarMutation() {
	return useMutation({
		mutationFn: async (serverId: string) => {
			return RPC.orpc.squadServer.toggleFogOfWar.call({ serverId, disabled: true })
		},
	})
}

export function useWarnPlayerMutation() {
	return useMutation({
		mutationFn: async (input: { serverId: string; playerId: string; reason: string }) => {
			return RPC.orpc.squadServer.warnPlayer.call(input)
		},
	})
}

export function useDemoteCommanderMutation() {
	return useMutation({
		mutationFn: async (input: { serverId: string; playerId: string }) => {
			return RPC.orpc.squadServer.demoteCommander.call(input)
		},
	})
}

export function useDisbandSquadMutation() {
	return useMutation({
		mutationFn: async (input: { serverId: string; teamId: 1 | 2; squadId: number }) => {
			return RPC.orpc.squadServer.disbandSquad.call(input)
		},
	})
}

export function useRemoveFromSquadMutation() {
	return useMutation({
		mutationFn: async (input: { serverId: string; playerId: string }) => {
			return RPC.orpc.squadServer.removeFromSquad.call(input)
		},
	})
}

export function useResetSquadNameMutation() {
	return useMutation({
		mutationFn: async (input: { serverId: string; teamId: 1 | 2; squadId: number }) => {
			return RPC.orpc.squadServer.renameSquad.call(input)
		},
	})
}

type PlayerSelectionStore = {
	selection: Record<string, boolean>
}

export const PlayerSelectionStore = Zus.createStore<PlayerSelectionStore>(() => ({
	selection: {},
}))

export namespace Actions {
	export function setSelection(updater: Record<string, boolean> | ((old: Record<string, boolean>) => Record<string, boolean>)) {
		const next = typeof updater === 'function' ? updater(PlayerSelectionStore.getState().selection) : updater
		PlayerSelectionStore.setState({ selection: next })
	}

	// players: the current squad's chat roster, e.g. `ChatPrt.Sel.chatState(frameState).players`
	export function selectSquad(playerId: SM.PlayerId, players: SM.Player[]) {
		const player = SM.PlayerIds.find(players, p => p.ids, playerId)
		if (!player?.squadId || !player.teamId) return
		const squadIds = players
			.filter(p => p.squadId === player.squadId && p.teamId === player.teamId)
			.map(p => SM.PlayerIds.getPlayerId(p.ids))
		PlayerSelectionStore.setState({ selection: Object.fromEntries(squadIds.map(id => [id, true])) })
	}
}

type SelectedServerStore = {
	selectedServerId: string
}

export let SelectedServerStore!: Zus.StoreApi<SelectedServerStore>

export namespace SelectedServerActions {
	export function setSelectedServer(serverId: string) {
		if (serverId === SelectedServerStore.getState().selectedServerId) return
		Cookies.setCookie('default-server-id', serverId)
		SelectedServerStore.setState({ selectedServerId: serverId })
	}

	export function setAsDefaultServer() {
		Cookies.setCookie('default-server-id', SelectedServerStore.getState().selectedServerId)
	}
}

export function setup() {
	// this cookie will always be set correctly according to the path on page load, which is the only time we expect setup() to be called
	const cookieServerId = Cookies.getCookie('default-server-id')!
	SelectedServerStore = Zus.createStore(() => ({
		selectedServerId: cookieServerId,
	}))
}

// keeps serverInfo/serverRolling/layersStatus hot for the given server's lifetime; called from the squadServer frame's setup
export function watchServer(serverId: string, sub: Rx.Subscription) {
	sub.add(serverInfoRes$(serverId).subscribe())
	sub.add(layersStatus$(serverId).subscribe())
	sub.add(serverRolling$(serverId).subscribe())
	sub.add(serverInfo$(serverId).subscribe())
}
