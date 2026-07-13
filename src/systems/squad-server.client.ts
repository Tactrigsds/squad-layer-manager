import * as ChatPrt from '@/frame-partials/chat.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as RxHelpers from '@/lib/react-rxjs-helpers'
import { toast } from '@/lib/toast'
import * as ZusUtils from '@/lib/zustand'
import * as AAR from '@/models/admin-action-reasons.models'
import type * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import * as TeamsPanelModels from '@/models/teams-panel.models'
import * as RPC from '@/orpc.client'
import * as Cookies from '@/systems/app-routes.client'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SettingsClient from '@/systems/settings.client'
import { useMutation } from '@tanstack/react-query'
import type * as React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { toStream } from 'zustand-rx'

// ids of the servers the backend currently has a live slice for. Runtime state, not registry config: a server can be
// enabled and non-broken yet have no slice (still booting, or torn down by a fatal resource error), and every per-server
// stream and action needs one. Gating the dashboard on this is what keeps an unloaded server from silently hanging.
export const [useLoadedServerIds, loadedServerIds$] = RxHelpers.bind(
	'squadServer.loadedServers',
	RPC.observe('squadServer.watchLoadedServers', () => RPC.orpc.squadServer.watchLoadedServers.call()),
)

// why a server's dashboard can't be shown. `starting` is the runtime case the registry can't tell us about: the server is
// configured to run and its settings are fine, but there's no live slice backing it yet.
export type ServerAvailability = 'ok' | 'not-found' | 'disabled' | 'broken' | 'starting'

// combined reactively rather than read through a selector closure: the registry (enabled/broken) and the loaded set are
// two independent sources, and both have to be able to move the result on their own. Enabling a server publishes the
// registry change first and the slice seconds later, so the dashboard is only reachable if that second signal lands.
export const [useServerAvailability, serverAvailability$] = RxHelpers.bind(
	'squadServer.serverAvailability',
	(serverId: string) =>
		Rx.combineLatest([
			// suspend rather than briefly claiming the server doesn't exist while settings are still in flight
			toStream(SettingsClient.PublicSettingsStore).pipe(Rx.filter((settings) => !!settings)),
			loadedServerIds$,
		]).pipe(
			Rx.map(([settings, loadedIds]): ServerAvailability => {
				const entry = settings.servers.find(s => s.id === serverId)
				if (!entry) return 'not-found'
				if (entry.broken) return 'broken'
				if (!entry.enabled) return 'disabled'
				return loadedIds.includes(serverId) ? 'ok' : 'starting'
			}),
			Rx.distinctUntilChanged(),
		),
)

// TODO we probably don't need to "bind" multiple observables like this. we should create some helper "derive" which lets us derive one state observable from another
export const [useLayersStatus, layersStatus$] = RxHelpers.bind(
	'squadServer.layersStatus',
	(serverId: string) =>
		RPC.observe('squadServer.watchLayersStatus', () => RPC.orpc.squadServer.watchLayersStatus.call({ serverId })).pipe(
			RPC.dropServerNotLoaded(),
		),
)
export const [useServerInfoRes, serverInfoRes$] = RxHelpers.bind(
	'squadServer.serverInfoRes',
	(serverId: string) =>
		RPC.observe('squadServer.watchServerInfo', () => RPC.orpc.squadServer.watchServerInfo.call({ serverId })).pipe(
			RPC.dropServerNotLoaded(),
		),
)
export const [useServerInfo, serverInfo$] = RxHelpers.bind(
	'squadServer.serverInfo',
	(serverId: string) =>
		serverInfoRes$(serverId).pipe(
			Rx.map(res => res.code === 'ok' ? res.data : null),
		),
)

export const [useServerRolling, serverRolling$] = RxHelpers.bind(
	'squadServer.serverRolling',
	(serverId: string) =>
		RPC.observe('squadServer.watchServerRolling', () => RPC.orpc.squadServer.watchServerRolling.call({ serverId })).pipe(
			RPC.dropServerNotLoaded(),
		),
)

export const [useTickRate, tickRate$] = RxHelpers.bind(
	'squadServer.tickRate',
	(serverId: string) =>
		RPC.observe('squadServer.watchTickRate', () => RPC.orpc.squadServer.watchTickRate.call({ serverId })).pipe(
			RPC.dropServerNotLoaded(),
		),
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

export function useWarnPlayersMutation() {
	return useMutation(RPC.orpc.squadServer.warnPlayers.mutationOptions())
}

// reads an action dialog's reason refs on confirm, enforcing the "require a reason" setting (mirrors the
// server-side check so the dialog can fail fast with a toast). Returns null when blocked; otherwise the
// mutation inputs (at most one of the two set).
export function readReasonInput(opts: {
	action: AAR.AdminActionType
	required: boolean
	presetRef: React.MutableRefObject<string>
	customRef?: React.MutableRefObject<string>
}): { reason?: string; presetReasonLabel?: string } | null {
	const presetReasonLabel = opts.presetRef.current || undefined
	const reason = presetReasonLabel ? undefined : opts.customRef?.current.trim() || undefined
	if (opts.required && !presetReasonLabel && !reason) {
		toast.error('Reason required', { description: `A reason is required for ${AAR.ADMIN_ACTIONS[opts.action].displayName}.` })
		return null
	}
	return { reason, presetReasonLabel }
}

export function useWarnAdminsMutation() {
	return useMutation(RPC.orpc.squadServer.warnAdmins.mutationOptions())
}

export function useBroadcastMutation() {
	return useMutation(RPC.orpc.squadServer.broadcast.mutationOptions())
}

export function useDemoteCommanderMutation() {
	return useMutation(RPC.orpc.squadServer.demoteCommander.mutationOptions())
}

// a plain kick (no timeout); timeouts go through TimeoutsClient
export function useKickPlayersMutation() {
	return useMutation(RPC.orpc.squadServer.kickPlayers.mutationOptions())
}

export function useKillMutation() {
	return useMutation(RPC.orpc.squadServer.kill.mutationOptions())
}

export function useDisbandSquadMutation() {
	return useMutation(RPC.orpc.squadServer.disbandSquad.mutationOptions())
}

export function useRemoveFromSquadMutation() {
	return useMutation(RPC.orpc.squadServer.removeFromSquad.mutationOptions())
}

export function useRemovePlayersFromSquadMutation() {
	return useMutation(RPC.orpc.squadServer.removePlayersFromSquad.mutationOptions())
}

export function useResetSquadNameMutation() {
	return useMutation(RPC.orpc.squadServer.renameSquad.mutationOptions())
}

type PlayerSelectionStore = {
	selection: Record<string, boolean>
}

export const PlayerSelectionStore = Zus.createStore<PlayerSelectionStore>(() => ({
	selection: {},
}))

// player ids currently on screen (after search/filters) in the teams-panel tables, keyed per table so
// each team/combined table publishes its own displayed rows independently. Selection-adding actions
// intersect against the union so "select all X" only ever draws on what's currently visible.
type VisiblePlayersStore = {
	byTable: Record<string, string[]>
}

export const VisiblePlayersStore = Zus.createStore<VisiblePlayersStore>(() => ({
	byTable: {},
}))

export namespace VisiblePlayersActions {
	export function setVisible(tableKey: string, ids: string[]) {
		VisiblePlayersStore.setState(s => ({ byTable: { ...s.byTable, [tableKey]: ids } }))
	}

	export function clearVisible(tableKey: string) {
		VisiblePlayersStore.setState(s => {
			if (!(tableKey in s.byTable)) return s
			const byTable = { ...s.byTable }
			delete byTable[tableKey]
			return { byTable }
		})
	}

	// null means no table has registered visible rows, so callers should not constrain to visibility
	export function getVisibleSet(): Set<string> | null {
		const byTable = VisiblePlayersStore.getState().byTable
		const keys = Object.keys(byTable)
		if (keys.length === 0) return null
		const set = new Set<string>()
		for (const key of keys) {
			for (const id of byTable[key]) set.add(id)
		}
		return set
	}
}

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
		selectPlayers(squadIds)
	}

	// additive: merges into the existing selection rather than replacing it. Only ever draws on rows
	// currently visible in the teams panel, so "select all X" respects the active search/filters.
	export function selectPlayers(playerIds: SM.PlayerId[]) {
		const visible = VisiblePlayersActions.getVisibleSet()
		const constrained = visible ? playerIds.filter(id => visible.has(id)) : playerIds
		PlayerSelectionStore.setState(s => ({
			selection: { ...s.selection, ...Object.fromEntries(constrained.map(id => [id, true])) },
		}))
	}

	// teamId (raw): when given, only players on that team are selected
	export function selectAllAdmins(stores: SquadServerFrame.KeyProp, teamId?: SM.TeamId) {
		const players = ChatPrt.Sel.chatState(ZusUtils.getState(stores.squadServer!)).players
		selectPlayers(players.filter(p => p.isAdmin && (teamId == null || p.teamId === teamId)).map(p => SM.PlayerIds.getPlayerId(p.ids)))
	}

	export function selectAllWithRole(stores: SquadServerFrame.KeyProp, role: string, teamId?: SM.TeamId) {
		const players = ChatPrt.Sel.chatState(ZusUtils.getState(stores.squadServer!)).players
		selectPlayers(
			players.filter(p => p.role === role && (teamId == null || p.teamId === teamId)).map(p => SM.PlayerIds.getPlayerId(p.ids)),
		)
	}

	export function selectAllSquadLeaders(stores: SquadServerFrame.KeyProp, teamId?: SM.TeamId) {
		const players = ChatPrt.Sel.chatState(ZusUtils.getState(stores.squadServer!)).players
		selectPlayers(players.filter(p => p.isLeader && (teamId == null || p.teamId === teamId)).map(p => SM.PlayerIds.getPlayerId(p.ids)))
	}

	export function selectAllTeamPlayers(stores: SquadServerFrame.KeyProp, teamId?: SM.TeamId) {
		const players = ChatPrt.Sel.chatState(ZusUtils.getState(stores.squadServer!)).players
		selectPlayers(
			players.filter(p => (teamId == null ? p.teamId !== null : p.teamId === teamId)).map(p => SM.PlayerIds.getPlayerId(p.ids)),
		)
	}

	// teamId (raw): when given, only that team's players flip selected <-> unselected and the rest of
	// the selection is preserved; without it every on-team player flips and stale entries are dropped
	export function invertSelection(stores: SquadServerFrame.KeyProp, teamId?: SM.TeamId) {
		const players = ChatPrt.Sel.chatState(ZusUtils.getState(stores.squadServer!)).players
		const current = PlayerSelectionStore.getState().selection
		const visible = VisiblePlayersActions.getVisibleSet()
		// without a teamId every on-team player flips and stale entries are dropped; but hidden players
		// must keep their current selection, so seed from `current` and only overwrite visible rows
		const next: Record<string, boolean> = teamId == null && visible == null ? {} : { ...current }
		for (const player of players) {
			if (player.teamId === null || (teamId != null && player.teamId !== teamId)) continue
			const playerId = SM.PlayerIds.getPlayerId(player.ids)
			if (visible && !visible.has(playerId)) continue
			if (current[playerId]) delete next[playerId]
			else next[playerId] = true
		}
		PlayerSelectionStore.setState({ selection: next })
	}

	export function selectGrouping(stores: SquadServerFrame.KeyProp, grouping: string, teamId?: SM.TeamId) {
		const enriched = getEnrichedPlayers(stores)
		selectPlayers(
			enriched.filter(p => p.grouping === grouping && (teamId == null || p.teamId === teamId)).map(p => SM.PlayerIds.getPlayerId(p.ids)),
		)
	}

	function getEnrichedPlayers(stores: SquadServerFrame.KeyProp): TeamsPanelModels.EnrichedPlayer[] {
		const serverId = stores.squadServer!.serverId
		const frameState = ZusUtils.getState(stores.squadServer!)
		const currentMatch = MatchHistoryClient.currentMatch$(serverId).getValue() as MH.MatchDetails
		const bmData = BattlemetricsClient.playerBmData$.getValue()
		const bmStore = BattlemetricsClient.Store.getState()
		const settings = SettingsClient.PublicSettingsStore.getState()
		return TeamsPanelModels.Sel.allEnrichedPlayers(frameState, currentMatch, bmData, bmStore, settings)
	}
}

type SelectedServerStore = {
	selectedServerId: string
}

export let SelectedServerStore!: Zus.StoreApi<SelectedServerStore>

export namespace SelectedServerActions {
	// only ids that map to a real server may be persisted as the default -- otherwise landing on an invalid route like
	// /servers/undefined (which renders a client 404) would poison the default-server-id cookie and the store
	function isKnownServer(serverId: string | undefined): serverId is string {
		if (!serverId) return false
		const settings = SettingsClient.PublicSettingsStore.getState()
		// if settings haven't loaded yet we can't validate, so don't drop a legitimate id
		if (!settings) return true
		// only a usable (enabled, non-broken) server should become the default -- otherwise the backend just clears it again
		return settings.servers.some((s) => s.id === serverId && SettingsClient.isServerUsable(s))
	}

	export function setSelectedServer(serverId: string) {
		if (serverId === SelectedServerStore.getState().selectedServerId) return
		if (!isKnownServer(serverId)) return
		Cookies.setCookie('default-server-id', serverId)
		SelectedServerStore.setState({ selectedServerId: serverId })
	}

	export function setAsDefaultServer() {
		const serverId = SelectedServerStore.getState().selectedServerId
		if (!isKnownServer(serverId)) return
		Cookies.setCookie('default-server-id', serverId)
	}
}

export type DashboardTab = 'layers' | 'secondary'

// active tab for the server dashboard's single-column layout. Lives here (rather than in the component) so the NavBar can
// drive it -- in single-column mode the tab switcher replaces the "Server" nav item instead of rendering as its own cluster.
export const DashboardTabStore = Zus.createStore<{ activeTab: DashboardTab }>(() => ({ activeTab: 'layers' }))

export namespace DashboardTabActions {
	export function setActiveTab(tab: DashboardTab) {
		DashboardTabStore.setState({ activeTab: tab })
	}
}

export function setup() {
	loadedServerIds$.subscribe()
	// this cookie is set correctly by the backend according to the path on page load (the only time we expect setup() to be
	// called); it may be absent when there are no enabled servers to default to, in which case '/' redirects to /servers
	const cookieServerId = Cookies.getCookie('default-server-id')!
	SelectedServerStore = Zus.createStore(() => ({
		selectedServerId: cookieServerId,
	}))
}

// keeps serverInfo/serverRolling/layersStatus hot for the given server's lifetime; called from the squadServer frame's setup
export function watchServer(serverId: string, sub: Rx.Subscription) {
	sub.add(serverInfoRes$(serverId).pipe(RxHelpers.retryHot()).subscribe())
	sub.add(layersStatus$(serverId).pipe(RxHelpers.retryHot()).subscribe())
	sub.add(serverRolling$(serverId).pipe(RxHelpers.retryHot()).subscribe())
	sub.add(tickRate$(serverId).pipe(RxHelpers.retryHot()).subscribe())
	sub.add(serverInfo$(serverId).pipe(RxHelpers.retryHot()).subscribe())
}
