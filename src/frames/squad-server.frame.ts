import * as ChatPrt from '@/frame-partials/chat.partial'
import * as LayerQueuePrt from '@/frame-partials/layer-queue.partial'
import * as ServerSettingsPrt from '@/frame-partials/server-settings.partial'
import * as TeamswapsPrt from '@/frame-partials/teamswaps.partial'
import type * as FRM from '@/lib/frame'
import * as ODSM from '@/lib/odsm'
import * as RSel from '@/lib/reselect'
import * as ZusUtils from '@/lib/zustand'

import type * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import type * as MH from '@/models/match-history.models'
import * as SETTINGS from '@/models/settings.models'
import * as SLL from '@/models/shared-layer-list'
import * as SM from '@/models/squad.models'
import * as TeamsPanelModels from '@/models/teams-panel.models'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import * as LayerQueueClient from '@/systems/layer-queue.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as VoteClient from '@/systems/vote.client'
import * as Rx from 'rxjs'

import { frameManager } from './frame-manager'

export type Input = { serverId: string }

export type State = ChatPrt.Store & ServerSettingsPrt.Store & LayerQueuePrt.Store & TeamswapsPrt.Store & {
	layerItemsState: LQY.LayerItemsState
	layerItemStatuses: LQY.LayerItemStatuses | null
	// the queue the statuses above were computed for. Statuses lag an edit by a debounce plus a query, so a caller that
	// has to be right about them (the save flow gates on warnings) can tell current answers from stale ones. Display
	// keeps using the stale ones meanwhile, which is what stops the indicators flickering on every edit.
	layerItemStatusesFor: LQY.LayerItemsState | null

	// the teams-panel player selection every bulk admin action reads from
	playerSelection: Record<SM.PlayerId, boolean>
	// player ids currently on screen (after search/filters) in the teams-panel tables, keyed per table so each
	// team/combined table publishes its own displayed rows independently. Selection-adding actions intersect against
	// the union so "select all X" only ever draws on what's currently visible.
	visiblePlayersByTable: Record<string, SM.PlayerId[]>
	// the selection once it stops moving. drag-to-select writes playerSelection once per row the cursor crosses, and
	// consumers that do real work per change (the activity feed re-filters its whole event buffer) read this instead.
	settledSelectedPlayerIds: Set<SM.PlayerId>
}
export type Types = {
	name: 'squadServer'
	key: FRM.RawInstanceKey<{ serverId: string }>
	input: Input
	state: State
}

export type Key = FRM.InstanceKey<Types>
export type KeyProp = FRM.KeyProp<Types>
export type Frame = FRM.Frame<Types>

export function createInput(serverId: string): Input {
	return { serverId }
}

export const frame = frameManager.createFrame<Types>({
	name: 'squadServer',
	createKey: (frameId, input) => ({ frameId, serverId: input.serverId }),
	setup(args) {
		ChatPrt.initChat(args)
		ServerSettingsPrt.initServerSettings(args)
		LayerQueuePrt.initLayerQueue(args)
		TeamswapsPrt.initTeamswaps(args)

		// keeps the read-only, per-server oRPC streams (serverInfo/serverRolling/layersStatus, vote state,
		// match history, unexpected-next-layer) hot for the lifetime of this frame instance
		SquadServerClient.watchServer(args.input.serverId, args.sub)
		VoteClient.watchServer(args.input.serverId, args.sub)
		MatchHistoryClient.watchServer(args.input.serverId, args.sub)
		LayerQueueClient.watchServer(args.input.serverId, args.sub)
		args.set({
			layerItemsState: LQY.initLayerItemsState(),
			layerItemStatuses: null,
			layerItemStatusesFor: null,
			playerSelection: {},
			visiblePlayersByTable: {},
			settledSelectedPlayerIds: new Set<SM.PlayerId>(),
		})

		args.sub.add(
			ZusUtils.toObservable(args.key, true).pipe(
				Rx.map(([state]) => state.playerSelection),
				Rx.distinctUntilChanged(),
				Rx.debounceTime(SELECTION_SETTLE_MS),
				Rx.map(selection => toSelectedIds(selection)),
				// consumers key their caches on the emitted set's identity, so compare by contents: a drag that ends
				// where it started shouldn't invalidate anything
				Rx.distinctUntilChanged(sameSelection),
			).subscribe(settledSelectedPlayerIds => args.set({ settledSelectedPlayerIds })),
		)

		Rx.combineLatest([
			args.update$.pipe(
				Rx.concatMap(([state, prev]): LL.List[] =>
					state.queue.layerList === prev.queue.layerList
						? []
						: [state.queue.layerList]
				),
			),
			MatchHistoryClient.recentMatches$(args.input.serverId),
		])
			.subscribe(([layerList, recentMatches]) => {
				args.set({
					layerItemsState: LQY.resolveLayerItemsState(layerList, recentMatches),
				})
			})

		const state$ = ZusUtils.toObservable(args.key, true)
		args.sub.add(
			Rx.combineLatest([
				state$.pipe(Rx.map(([state]) => state.layerItemsState), Rx.distinctUntilChanged()),
				state$.pipe(Rx.map(([state]) => state.settings.saved), Rx.distinctUntilChanged()),
				// filter edits invalidate previously computed statuses
				ZusUtils.toObservable(LayerQueriesClient.Store, true).pipe(
					Rx.map(([state]) => state.backgroundStateEpoch),
					Rx.distinctUntilChanged(),
				),
			]).pipe(
				Rx.debounceTime(250),
				Rx.switchMap(([list, settings]) =>
					Rx.from(LayerQueriesClient.fetchLayerItemStatuses({
						constraints: SETTINGS.getSettingsConstraints(settings),
						list,
					})).pipe(
						Rx.map((layerItemStatuses) => [layerItemStatuses, list] as const),
						Rx.catchError(() => Rx.EMPTY),
					)
				),
			).subscribe(([layerItemStatuses, list]) => {
				if (layerItemStatuses) args.set({ layerItemStatuses, layerItemStatusesFor: list })
			}),
		)
	},
})

export function getLayerItemState$(squadServer: Key) {
	const list$ = ZusUtils.toObservable(squadServer, true).pipe(Rx.map(([state]) => state.queue.layerList), Rx.distinctUntilChanged())
	const history$ = MatchHistoryClient.recentMatches$(squadServer.serverId)
	return Rx.combineLatest([list$, history$]).pipe(Rx.map(([list, history]) => LQY.resolveLayerItemsState(list, history)))
}

export namespace Sel {
	export function settings(s: State) {
		return s.settings.saved
	}
	export function settingsOrDefault(s: State | undefined) {
		return s?.settings.saved ?? SETTINGS.PublicServerSettingsSchema.parse({})
	}

	export function playerSelection(s: State) {
		return s.playerSelection
	}
	// memoized on the selection object, which setSelection replaces wholesale, so the Set stays reference-stable
	export const selectedPlayerIds = RSel.createSelector([playerSelection], toSelectedIds)
	export function settledSelectedPlayerIds(s: State) {
		return s.settledSelectedPlayerIds
	}
	export function selectedPlayerCount(s: State) {
		return selectedPlayerIds(s).size
	}
	export function hasSelection(s: State) {
		return selectedPlayerCount(s) > 0
	}
}

// ---------------------------- player selection ----------------------------

const SELECTION_SETTLE_MS = 200

function toSelectedIds(selection: Record<SM.PlayerId, boolean>): Set<SM.PlayerId> {
	return new Set(Object.keys(selection).filter(id => selection[id]))
}

function sameSelection(a: Set<SM.PlayerId>, b: Set<SM.PlayerId>): boolean {
	if (a === b) return true
	if (a.size !== b.size) return false
	for (const id of a) {
		if (!b.has(id)) return false
	}
	return true
}

// null means no table has registered visible rows, so callers should not constrain to visibility
function visiblePlayerSet(state: State): Set<SM.PlayerId> | null {
	const byTable = state.visiblePlayersByTable
	const keys = Object.keys(byTable)
	if (keys.length === 0) return null
	const set = new Set<SM.PlayerId>()
	for (const key of keys) {
		for (const id of byTable[key]) set.add(id)
	}
	return set
}

export namespace Actions {
	function store(stores: KeyProp) {
		return ZusUtils.resolveStore<State>(stores.squadServer!)
	}

	export function setSelection(
		stores: KeyProp,
		updater: Record<SM.PlayerId, boolean> | ((old: Record<SM.PlayerId, boolean>) => Record<SM.PlayerId, boolean>),
	) {
		const s = store(stores)
		const next = typeof updater === 'function' ? updater(s.getState().playerSelection) : updater
		s.setState({ playerSelection: next })
	}

	// additive: merges into the existing selection rather than replacing it. Only ever draws on rows
	// currently visible in the teams panel, so "select all X" respects the active search/filters.
	export function selectPlayers(stores: KeyProp, playerIds: SM.PlayerId[]) {
		const s = store(stores)
		const visible = visiblePlayerSet(s.getState())
		const constrained = visible ? playerIds.filter(id => visible.has(id)) : playerIds
		s.setState(state => ({
			playerSelection: { ...state.playerSelection, ...Object.fromEntries(constrained.map(id => [id, true])) },
		}))
	}

	export function selectSquad(stores: KeyProp, playerId: SM.PlayerId) {
		const players = ChatPrt.Sel.chatState(ZusUtils.getState(stores.squadServer!)).players
		const player = SM.PlayerIds.find(players, p => p.ids, playerId)
		if (!player?.squadId || !player.teamId) return
		const squadIds = players
			.filter(p => p.squadId === player.squadId && p.teamId === player.teamId)
			.map(p => SM.PlayerIds.getPlayerId(p.ids))
		selectPlayers(stores, squadIds)
	}

	// teamId (raw): when given, only players on that team are selected
	export function selectAllAdmins(stores: KeyProp, teamId?: SM.TeamId) {
		const players = ChatPrt.Sel.chatState(ZusUtils.getState(stores.squadServer!)).players
		selectPlayers(
			stores,
			players.filter(p => p.isAdmin && (teamId == null || p.teamId === teamId)).map(p => SM.PlayerIds.getPlayerId(p.ids)),
		)
	}

	export function selectAllWithRole(stores: KeyProp, role: string, teamId?: SM.TeamId) {
		const players = ChatPrt.Sel.chatState(ZusUtils.getState(stores.squadServer!)).players
		selectPlayers(
			stores,
			players.filter(p => p.role === role && (teamId == null || p.teamId === teamId)).map(p => SM.PlayerIds.getPlayerId(p.ids)),
		)
	}

	export function selectAllSquadLeaders(stores: KeyProp, teamId?: SM.TeamId) {
		const players = ChatPrt.Sel.chatState(ZusUtils.getState(stores.squadServer!)).players
		selectPlayers(
			stores,
			players.filter(p => p.isLeader && (teamId == null || p.teamId === teamId)).map(p => SM.PlayerIds.getPlayerId(p.ids)),
		)
	}

	export function selectAllTeamPlayers(stores: KeyProp, teamId?: SM.TeamId) {
		const players = ChatPrt.Sel.chatState(ZusUtils.getState(stores.squadServer!)).players
		selectPlayers(
			stores,
			players.filter(p => (teamId == null ? p.teamId !== null : p.teamId === teamId)).map(p => SM.PlayerIds.getPlayerId(p.ids)),
		)
	}

	export function selectGrouping(stores: KeyProp, grouping: string, teamId?: SM.TeamId) {
		const enriched = getEnrichedPlayers(stores)
		selectPlayers(
			stores,
			enriched.filter(p => p.grouping === grouping && (teamId == null || p.teamId === teamId)).map(p => SM.PlayerIds.getPlayerId(p.ids)),
		)
	}

	// teamId (raw): when given, only that team's players flip selected <-> unselected and the rest of
	// the selection is preserved; without it every on-team player flips and stale entries are dropped
	export function invertSelection(stores: KeyProp, teamId?: SM.TeamId) {
		const s = store(stores)
		const state = s.getState()
		const players = ChatPrt.Sel.chatState(state).players
		const current = state.playerSelection
		const visible = visiblePlayerSet(state)
		// without a teamId every on-team player flips and stale entries are dropped; but hidden players
		// must keep their current selection, so seed from `current` and only overwrite visible rows
		const next: Record<SM.PlayerId, boolean> = teamId == null && visible == null ? {} : { ...current }
		for (const player of players) {
			if (player.teamId === null || (teamId != null && player.teamId !== teamId)) continue
			const playerId = SM.PlayerIds.getPlayerId(player.ids)
			if (visible && !visible.has(playerId)) continue
			if (current[playerId]) delete next[playerId]
			else next[playerId] = true
		}
		s.setState({ playerSelection: next })
	}

	export function setVisiblePlayers(stores: KeyProp, tableKey: string, playerIds: SM.PlayerId[]) {
		store(stores).setState(state => ({ visiblePlayersByTable: { ...state.visiblePlayersByTable, [tableKey]: playerIds } }))
	}

	export function clearVisiblePlayers(stores: KeyProp, tableKey: string) {
		store(stores).setState(state => {
			if (!(tableKey in state.visiblePlayersByTable)) return state
			const visiblePlayersByTable = { ...state.visiblePlayersByTable }
			delete visiblePlayersByTable[tableKey]
			return { visiblePlayersByTable }
		})
	}

	function getEnrichedPlayers(stores: KeyProp): TeamsPanelModels.EnrichedPlayer[] {
		const serverId = stores.squadServer!.serverId
		const frameState = ZusUtils.getState(stores.squadServer!)
		const currentMatch = MatchHistoryClient.currentMatch$(serverId).getValue() as MH.MatchDetails
		const bmData = BattlemetricsClient.playerBmData$.getValue()
		const bmStore = BattlemetricsClient.Store.getState()
		const settings = SettingsClient.PublicSettingsStore.getState()
		return TeamsPanelModels.Sel.allEnrichedPlayers(frameState, currentMatch, bmData, bmStore, settings)
	}
}

// ---------------------------- layer item statuses ----------------------------

export function statusesAreCurrent(state: State) {
	return state.layerItemStatusesFor === state.layerItemsState
}

// The warnings the queue would raise if it were saved as it stands: repeat-rule violations and pool-filter warnings on
// items the user themselves put there. Null means "nothing to warn about", which is also what an unloaded status set
// reports, so callers that must not skip a warning wait for current statuses first (see awaitCurrentStatuses).
export function selectQueueWarnings(state: State, userDiscordId: bigint | undefined): LQY.QueueWarning[] | null {
	const warns = state.layerItemStatuses?.warns
	if (!warns || warns.length === 0 || !userDiscordId) return null
	const modifiedByUser = state.queue.isModified
		&& SLL.hasUserMutations(ODSM.Client.localOps(state.queue.rbSession), state.queue.rbSession.localState, userDiscordId)
	if (!modifiedByUser) return null
	return warns
}

// Statuses lag the queue by a debounce plus a query, so reading them straight after an edit gates the save on warnings
// computed for a list the user has already edited away from -- which is how a stale warning could both block a save
// and then vanish, leaving the editor stuck. Wait for the statuses that belong to the queue as it is now.
export async function awaitCurrentStatuses(key: ZusUtils.AnyStore<State>, timeoutMs = 5000): Promise<void> {
	if (statusesAreCurrent(ZusUtils.getState(key))) return
	await Rx.firstValueFrom(
		ZusUtils.toObservable(key, true).pipe(
			Rx.filter(([state]) => statusesAreCurrent(state)),
			// a query that never lands must not strand the editor: fall through and gate on what we have
			Rx.timeout({ first: timeoutMs, with: () => Rx.of(null) }),
		),
	)
}
