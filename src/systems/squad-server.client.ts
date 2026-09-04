import { useMutation } from '@tanstack/react-query'
import * as TSR from '@tanstack/react-router'
import type * as React from 'react'

import * as Browser from '@/lib/browser'
import type * as Cleanup from '@/lib/cleanup'
import * as ReactRx from '@/lib/react-rxjs'
import * as Rx from '@/lib/rxjs'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards'
import * as Zus from '@/lib/zustand'
import * as SS_Msgs from '@/messages/server-state.messages'
import * as SM_Msgs from '@/messages/squad.messages'
import * as AAR from '@/models/admin-action-reasons.models'
import * as RPC from '@/orpc.client'
import { rootRouter } from '@/root-router'
import * as Cookies from '@/systems/app-routes.client'
import * as ClientOnlySettings from '@/systems/client-only-settings.client'
import { tr } from '@/systems/messages.client'
import * as SettingsClient from '@/systems/settings.client'

// ids of the servers the backend currently has a live managed server for. Runtime state, not registry config: a server can be
// enabled and non-broken yet have no managed server (still booting, or torn down by a fatal resource error), and every per-server
// stream and action needs one. Gating the dashboard on this is what keeps an unloaded server from silently hanging.
export const [useLoadedServerIds, loadedServerIds$] = ReactRx.bind(
	'squadServer.loadedServers',
	RPC.observe('squadServer.watchLoadedServers', () => RPC.orpc.squadServer.watchLoadedServers.call()),
)

// why a server's dashboard can't be shown. `starting` is the runtime case the registry can't tell us about: the server is
// configured to run and its settings are fine, but there's no live managed server backing it yet.
export type ServerAvailability = 'ok' | 'not-found' | 'disabled' | 'broken' | 'starting'

// combined reactively rather than read through a selector closure: the registry (enabled/broken) and the loaded set are
// two independent sources, and both have to be able to move the result on their own. Enabling a server publishes the
// registry change first and the managed server seconds later, so the dashboard is only reachable if that second signal lands.
export const [useServerAvailability, serverAvailability$] = ReactRx.bind('squadServer.serverAvailability', (serverId: string) =>
	Rx.combineLatest([
		// suspend rather than briefly claiming the server doesn't exist while settings are still in flight.
		// fireImmediately: settings are normally already loaded by the time anything subscribes, and without the
		// current value replayed combineLatest would sit waiting on a settings *change* that never comes
		Zus.toStream(SettingsClient.PublicSettingsStore, undefined, { fireImmediately: true }).pipe(Rx.filter((settings) => !!settings)),
		loadedServerIds$,
	]).pipe(
		Rx.map(([settings, loadedIds]): ServerAvailability => {
			const entry = settings.servers.find((s) => s.id === serverId)
			if (!entry) return 'not-found'
			if (entry.broken) return 'broken'
			if (!entry.enabled) return 'disabled'
			return loadedIds.includes(serverId) ? 'ok' : 'starting'
		}),
		Rx.distinctUntilChanged(),
	),
)

// TODO we probably don't need to "bind" multiple observables like this. we should create some helper "derive" which lets us derive one state observable from another
export const [useLayersStatus, layersStatus$] = ReactRx.bind('squadServer.layersStatus', (serverId: string) =>
	RPC.observe('squadServer.watchLayersStatus', () => RPC.orpc.squadServer.watchLayersStatus.call({ serverId })).pipe(
		RPC.dropServerNotLoaded(),
	),
)
export const [useServerInfoRes, serverInfoRes$] = ReactRx.bind('squadServer.serverInfoRes', (serverId: string) =>
	RPC.observe('squadServer.watchServerInfo', () => RPC.orpc.squadServer.watchServerInfo.call({ serverId })).pipe(
		RPC.dropServerNotLoaded(),
	),
)
export const [useServerInfo, serverInfo$] = ReactRx.bind('squadServer.serverInfo', (serverId: string) =>
	serverInfoRes$(serverId).pipe(Rx.map((res) => (res.code === 'ok' ? res.data : null))),
)

export const [useServerRolling, serverRolling$] = ReactRx.bind('squadServer.serverRolling', (serverId: string) =>
	RPC.observe('squadServer.watchServerRolling', () => RPC.orpc.squadServer.watchServerRolling.call({ serverId })).pipe(
		RPC.dropServerNotLoaded(),
	),
)

export const [useTickRate, tickRate$] = ReactRx.bind('squadServer.tickRate', (serverId: string) =>
	RPC.observe('squadServer.watchTickRate', () => RPC.orpc.squadServer.watchTickRate.call({ serverId })).pipe(RPC.dropServerNotLoaded()),
)

// Asked for on the click rather than kept warm: the link carries a steam lobby id that the server replaces as
// it rolls, and the api rate-limits the lookup per server, so a dashboard left open must not spend requests
// keeping one online. Handing the url to location lets the browser pass steam:// to its protocol handler.
async function joinServer(serverId: string) {
	const res = await RPC.orpc.squadServer.getJoinLink.call({ serverId })
	switch (res.code) {
		case 'ok':
			window.location.href = res.joinUrl
			return
		case 'err:no-such-server':
			toast.error(...tr.toast(SS_Msgs.joinLinkNotIndexed()))
			return
		case 'err:rate-limited':
			toast.error(...tr.toast(SS_Msgs.joinLinkRateLimited()))
			return
		case 'err:no-lobby':
			toast.error(...tr.toast(SS_Msgs.joinLinkNoLobby()))
			return
		case 'err:disabled':
		case 'err:request-failed':
		case 'err:rcon':
		case 'err:server-not-loaded':
		case 'err:permission-denied':
			toast.error(...tr.toast(SS_Msgs.joinLinkFailed()))
			return
		default:
			assertNever(res)
	}
}

export function useJoinServer() {
	return useMutation({ mutationFn: joinServer })
}

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
		toast.error(...tr.toast(SM_Msgs.reasonRequired(AAR.ADMIN_ACTIONS[opts.action].displayName)))
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

export type DashboardTab = ClientOnlySettings.DashboardTab
// the single-column layout shows one of two sides; the phone's four tabs fold onto them
export type DashboardSide = 'layers' | 'secondary'

export function dashboardSide(tab: DashboardTab): DashboardSide {
	return tab === 'activity' ? 'secondary' : 'layers'
}

// The dashboard's tab is the route's `?tab=` search param, so a switch is a history entry and back returns to the
// previous tab. A visit without one lands on the tab last shown (persisted client-side; the route keeps that in step
// and replaces a bare url with it, see servers.$serverId.tsx). Read here rather than in the route so the NavBar,
// which sits outside it, can drive the single-column switcher.
export function useDashboardTab(): DashboardTab {
	const fromUrl = TSR.useMatch({ from: '/_app/servers/$serverId', shouldThrow: false, select: (m) => m.search.tab })
	const stored = Zus.useStore(ClientOnlySettings.Store, (s) => s.dashboardTab)
	return fromUrl ?? stored
}

export namespace DashboardTabActions {
	export function setTab(tab: DashboardTab) {
		void rootRouter.navigate({
			to: '/servers/$serverId',
			params: { serverId: SelectedServerStore.getState().selectedServerId },
			search: { tab },
		})
	}
	// the layers side of the single-column layout is the queue unless the last pick was teams
	export function setSide(side: DashboardSide) {
		const last = ClientOnlySettings.Store.getState().dashboardTab
		setTab(side === 'secondary' ? 'activity' : last === 'teams' ? 'teams' : 'queue')
	}
}

// The three-column tier shows the queue and the teams at once, so there is no tab to report as the panel being
// viewed. Presence then follows the section last interacted with, queue by default. That choice is never
// persisted: a window that drops back below the tier reports the saved tab again.
const StackedSectionStore = Zus.createStore<{ section: ClientOnlySettings.PrimaryPanelTab }>()(() => ({ section: 'VIEWING_QUEUE' }))

export function viewedPrimaryPanel(): ClientOnlySettings.PrimaryPanelTab {
	return window.matchMedia(Browser.ULTRAWIDE_QUERY).matches
		? StackedSectionStore.getState().section
		: ClientOnlySettings.Store.getState().primaryPanelTab
}

export const viewedPrimaryPanel$: Rx.Observable<ClientOnlySettings.PrimaryPanelTab> = Rx.merge(
	Browser.mediaQueryChanged$(Browser.ULTRAWIDE_QUERY),
	Zus.toObservable(StackedSectionStore),
	Zus.toObservable(ClientOnlySettings.Store),
).pipe(Rx.map(viewedPrimaryPanel), Rx.distinctUntilChanged())

// the element holding the teams panel in either layout, so showTeams can scroll it into view
export const TEAMS_PANEL_ELEMENT_ID = 'primary-panel-panel-teams'

export namespace PrimaryPanelActions {
	// a click or a focus landed in one of the stacked sections
	export function touchStackedSection(section: ClientOnlySettings.PrimaryPanelTab) {
		if (StackedSectionStore.getState().section !== section) StackedSectionStore.setState({ section })
	}

	// brings the teams on screen: the tab below the ultrawide tier, the stacked section above it
	export function showTeams() {
		ClientOnlySettings.Actions.setPrimaryPanelTab('VIEWING_TEAMS')
		touchStackedSection('VIEWING_TEAMS')
		document.getElementById(TEAMS_PANEL_ELEMENT_ID)?.scrollIntoView({ block: 'start' })
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
export function watchServer(serverId: string, cleanup: Cleanup.Tasks) {
	cleanup.push(serverInfoRes$(serverId).pipe(ReactRx.retryHot()).subscribe())
	cleanup.push(layersStatus$(serverId).pipe(ReactRx.retryHot()).subscribe())
	cleanup.push(serverRolling$(serverId).pipe(ReactRx.retryHot()).subscribe())
	cleanup.push(tickRate$(serverId).pipe(ReactRx.retryHot()).subscribe())
	cleanup.push(serverInfo$(serverId).pipe(ReactRx.retryHot()).subscribe())
}
