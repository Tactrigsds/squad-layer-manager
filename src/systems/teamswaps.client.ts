import * as ChatPrt from '@/frame-partials/chat.partial'
import * as ServerSettingsPrt from '@/frame-partials/server-settings.partial'
import * as TeamswapsPrt from '@/frame-partials/teamswaps.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as ItemMut from '@/lib/item-mutations'
import * as Obj from '@/lib/object-utils'
import * as RSel from '@/lib/reselect'
import { toast } from '@/lib/toast'
import * as Zus from '@/lib/zustand'
import * as SETTINGS_Msgs from '@/messages/settings.messages'
import * as MH from '@/models/match-history.models'
import * as PG from '@/models/player-groupings.models'
import * as SM from '@/models/squad.models'
import * as TSWCB from '@/models/teamswap-counterbalance.models'
import * as TSW from '@/models/teamswaps.models'
import * as UP from '@/models/user-presence.models'
import type * as USR from '@/models/users.models'
import * as RPC from '@/orpc.client'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import { tr } from '@/systems/messages.client'
import * as RbacClient from '@/systems/rbac.client'
import * as SettingsClient from '@/systems/settings.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'

export type Store = TeamswapsPrt.Store

export namespace Sel {
	export function localState(store: Store) {
		return store.teamswaps.session.localState
	}

	export function diffAfterSwapsForTeam(team: MH.NormedTeamId): (store: Store) => number {
		return (store: Store) => {
			const state = localState(store)
			let count = 0
			for (const swap_ of state.editedSwaps.values()) {
				if (swap_.toTeam === team) {
					count++
				} else {
					count--
				}
			}
			return count
		}
	}

	export function hasSwaps(store: Store) {
		return localState(store).editedSwaps.size > 0 || localState(store).savedSwaps.size > 0
	}

	export function swapsModified(store: Store) {
		const state = localState(store)
		return !Obj.deepEqual(state.editedSwaps, state.savedSwaps)
	}

	export function canExecuteSavedTeamswaps(store: Store) {
		return TSW.canExecuteSavedTeamswaps(localState(store))
	}

	export function swapCounts(store: Store) {
		const state = localState(store)
		const counts: Record<MH.NormedTeamId, number> = { A: 0, B: 0 }
		for (const swap_ of state.editedSwaps.values()) {
			counts[swap_.toTeam]++
		}
		return counts
	}

	export function canSwapNow(playerIds: SM.PlayerId[]): (store: Store) => boolean {
		return (store: Store) => TSW.allCanSwapNow(localState(store), playerIds)
	}

	export function canQueue(playerIds: SM.PlayerId[]): (store: Store) => boolean {
		return (store: Store) => TSW.allCanQueue(localState(store), playerIds)
	}

	export function someCanQueue(playerIds: SM.PlayerId[]): (store: Store) => boolean {
		return (store: Store) => TSW.someCanQueue(localState(store), playerIds)
	}

	export const isSwapPending = RSel.memoizeFactoryLru(
		(playerId: SM.PlayerId) =>
			(store: Store): boolean =>
				TSW.isSwapPending(localState(store), playerId),
		// well above the players on a full server, one selector per player row
		256,
	)

	export function swapsToTeamEnriched(store: Store & ChatPrt.Store, team: MH.NormedTeamId): Map<SM.PlayerId, TSW.EnrichedTeamswap> {
		const swaps = localState(store).editedSwaps
		const players = ChatPrt.Sel.players(store)
		const result: Map<SM.PlayerId, TSW.EnrichedTeamswap> = new Map()
		for (const [playerId, swap_] of swaps.entries()) {
			if (swap_.toTeam !== team) continue
			const player = SM.PlayerIds.find(players, (p) => p.ids, playerId)
			if (!player) continue
			result.set(playerId, { ...swap_, player })
		}
		return result
	}

	export type EnrichedTeamswapWithMutation = TSW.EnrichedTeamswap & {
		mutation: ItemMut.ItemMutationState
	}

	type SwapsInputs = Store & ChatPrt.Store
	// deep-checked, so a roster change that leaves every swapped player as they were keeps the same map
	const swapsWithMutationsForTeam = RSel.memoizeFactory((team: MH.NormedTeamId) =>
		RSel.createDeepSelector(
			[
				(store: SwapsInputs) => localState(store).editedSwaps,
				(store: SwapsInputs) => localState(store).savedSwaps,
				(store: SwapsInputs) => ChatPrt.Sel.players(store),
			],
			(swaps, savedSwaps, players): Map<SM.PlayerId, EnrichedTeamswapWithMutation> => {
				const mutations = ItemMut.initMutations<SM.PlayerId>()
				const allPlayerIds = new Set<SM.PlayerId>()

				for (const [playerId, swap_] of swaps.entries()) {
					if (swap_.toTeam !== team) continue
					allPlayerIds.add(playerId)
					if (!savedSwaps.has(playerId)) {
						ItemMut.tryApplyMutation('added', playerId, mutations)
					}
				}
				for (const [playerId, swap_] of savedSwaps.entries()) {
					if (swap_.toTeam !== team) continue
					allPlayerIds.add(playerId)
					if (!swaps.has(playerId)) {
						ItemMut.tryApplyMutation('removed', playerId, mutations)
					}
				}

				const result = new Map<SM.PlayerId, EnrichedTeamswapWithMutation>()
				for (const playerId of allPlayerIds) {
					const swap_ = swaps.get(playerId) ?? savedSwaps.get(playerId)!
					const player = SM.PlayerIds.find(players, (p) => p.ids, playerId)
					if (!player) continue
					result.set(playerId, { ...swap_, player, mutation: ItemMut.toItemMutationState(mutations, playerId) })
				}
				return result
			},
		),
	)

	export function swapsToTeamEnrichedWithMutations(
		store: SwapsInputs,
		team: MH.NormedTeamId,
	): Map<SM.PlayerId, EnrichedTeamswapWithMutation> {
		return swapsWithMutationsForTeam(team)(store)
	}
}

function currentMatchNow(serverId: string): MH.MatchDetails | undefined {
	const matchesResult = MatchHistoryClient.recentMatches$(serverId).getValue()
	if (matchesResult instanceof Promise) return undefined
	return matchesResult[matchesResult.length - 1] as MH.MatchDetails | undefined
}

function getPlayerOppositeTeam(stores: SquadServerFrame.KeyProp, playerId: SM.PlayerId): MH.NormedTeamId | null {
	const state = Zus.getState(stores.squadServer)
	const players = ChatPrt.Sel.players(state)
	return TeamswapsPrt.getPlayerOppositeTeam(playerId, currentMatchNow(stores.squadServer.serverId), players)
}

const NO_STATS: TSWCB.PlayerStats = { kills: 0, wounds: 0, deaths: 0 }

// Re-picks the counterbalance swaps against the edit set as it now stands. Called only after an admin's own edit and
// never on a roster change, which is what keeps counterbalance a response to deliberate swaps.
function counterbalance(stores: SquadServerFrame.KeyProp, source: USR.GuiOrChatUserId) {
	const frameState = Zus.getState(stores.squadServer)
	const settings = ServerSettingsPrt.Sel.saved(frameState).teamswapCounterbalance
	if (!settings.enabled) return
	const match = currentMatchNow(stores.squadServer.serverId)
	if (!match) return
	const state = Sel.localState(frameState)
	const chat = ChatPrt.Sel.chatState(frameState)
	const players: TSWCB.Candidate[] = []
	for (const [playerId, player] of chat.players) {
		if (player.teamId === null) continue
		players.push({
			playerId,
			team: MH.getNormedTeamId(player.teamId, match.ordinal),
			partyId: player.partyId ?? null,
			stats: chat.playerStats[playerId] ?? NO_STATS,
			facts: BattlemetricsClient.playerFactsNow(playerId, player),
		})
	}
	const manualSwaps = new Map<SM.PlayerId, MH.NormedTeamId>()
	for (const [playerId, swap_] of state.editedSwaps) {
		if (!swap_.counterbalance) manualSwaps.set(playerId, swap_.toTeam)
	}
	const result = TSWCB.compute({
		settings,
		groupings: SettingsClient.PublicSettingsStore.getState()?.playerGroupings ?? PG.EMPTY_PLAYER_GROUPINGS,
		players,
		manualSwaps,
		skipped: frameState.teamswaps.counterbalanceSkipped,
		pending: new Set(state.pendingSwaps.keys()),
	})
	TeamswapsPrt.Actions.dispatch({ teamswaps: stores.squadServer }, { code: 'set-counterbalance-swaps', source, swaps: result.swaps })
}

// Records the counterbalance swaps among `removing`, so counterbalance picks someone else in their place. A synced edit
// set starts a fresh edit, so it forgets what earlier edits skipped.
function skipCounterbalanced(stores: SquadServerFrame.KeyProp, removing: SM.PlayerId[]) {
	const slice = Zus.toPartialStore(stores.squadServer, 'teamswaps')
	const { session, counterbalanceSkipped } = slice.getState()
	const { editedSwaps, savedSwaps } = session.localState
	const next = new Set(editedSwaps === savedSwaps ? [] : counterbalanceSkipped)
	for (const playerId of removing) {
		if (editedSwaps.get(playerId)?.counterbalance) next.add(playerId)
	}
	if (next.size === 0 && counterbalanceSkipped.size === 0) return
	slice.setState({ counterbalanceSkipped: next })
}

export namespace Actions {
	export function ensureViewingTeams(serverId: string) {
		UPClient.Actions.updateActivity(UP.Trans.viewingTeams(serverId).create())
	}

	function setEditing(serverId: string) {
		UPClient.Actions.updateActivity(UP.Trans.editingTeamswaps(serverId).create())
	}
	function clearEditing(serverId: string) {
		UPClient.Actions.updateActivity(UP.Trans.editingTeamswaps(serverId).destroy())
	}

	export function swapNext(stores: SquadServerFrame.KeyProp, playerIds: SM.PlayerId[]) {
		const source = { discordId: UsersClient.loggedInUserId }
		const state = Sel.localState(Zus.getState(stores.squadServer))
		for (const playerId of playerIds) {
			if (!TSW.canQueue(state, playerId)) continue
			const toTeam = getPlayerOppositeTeam(stores, playerId)
			if (!toTeam) continue
			TeamswapsPrt.Actions.dispatch(
				{ teamswaps: stores.squadServer },
				{
					code: 'add-player-teamswap',
					playerId,
					toTeam,
					source,
					saved: false,
				},
			)
		}
		counterbalance(stores, source)
		setEditing(stores.squadServer.serverId)
	}

	export function removeSwap(stores: SquadServerFrame.KeyProp, playerIds: SM.PlayerId[]) {
		const source = { discordId: UsersClient.loggedInUserId }
		skipCounterbalanced(stores, playerIds)
		for (const playerId of playerIds) {
			TeamswapsPrt.Actions.dispatch(
				{ teamswaps: stores.squadServer },
				{ code: 'remove-player-teamswaps', playerId, source, saved: false },
			)
		}
		counterbalance(stores, source)
		setEditing(stores.squadServer.serverId)
	}

	export function swapNow(stores: SquadServerFrame.KeyProp, playerIds: SM.PlayerId[]) {
		const source = { discordId: UsersClient.loggedInUserId }
		const swaps: TSW.TeamswapCollection = new Map()
		for (const playerId of playerIds) {
			const toTeam = getPlayerOppositeTeam(stores, playerId)
			if (!toTeam) continue
			swaps.set(playerId, { toTeam, source })
		}
		if (swaps.size > 0) {
			ensureViewingTeams(stores.squadServer.serverId)
			TeamswapsPrt.Actions.dispatch({ teamswaps: stores.squadServer }, { code: 'swap-now', swaps, source })
		}
	}

	export function clearTeamSwaps(stores: SquadServerFrame.KeyProp, teamId: MH.NormedTeamId) {
		const source = { discordId: UsersClient.loggedInUserId }
		const state = Sel.localState(Zus.getState(stores.squadServer))
		const playerIds = [...state.editedSwaps].filter(([, swap_]) => swap_.toTeam === teamId).map(([playerId]) => playerId)
		skipCounterbalanced(stores, playerIds)
		for (const playerId of playerIds) {
			TeamswapsPrt.Actions.dispatch(
				{ teamswaps: stores.squadServer },
				{ code: 'remove-player-teamswaps', playerId, source, saved: false },
			)
		}
		counterbalance(stores, source)
		setEditing(stores.squadServer.serverId)
	}

	export function executeTeamswaps(stores: SquadServerFrame.KeyProp) {
		ensureViewingTeams(stores.squadServer.serverId)
		const source = { discordId: UsersClient.loggedInUserId }
		TeamswapsPrt.Actions.dispatch({ teamswaps: stores.squadServer }, { code: 'execute-teamswaps', source })
	}

	export function save(stores: SquadServerFrame.KeyProp) {
		const source = { discordId: UsersClient.loggedInUserId }
		TeamswapsPrt.Actions.dispatch({ teamswaps: stores.squadServer }, { code: 'save', source })
	}

	export function revertToSaved(stores: SquadServerFrame.KeyProp) {
		ensureViewingTeams(stores.squadServer.serverId)
		const source = { discordId: UsersClient.loggedInUserId }
		TeamswapsPrt.Actions.dispatch({ teamswaps: stores.squadServer }, { code: 'revert-to-saved', source })
		Zus.toPartialStore(stores.squadServer, 'teamswaps').setState({ counterbalanceSkipped: new Set() })
		clearEditing(stores.squadServer.serverId)
	}

	// writes straight to the saved settings, so the switch takes effect for every admin at once
	export async function setCounterbalanceEnabled(stores: SquadServerFrame.KeyProp, enabled: boolean) {
		try {
			const res = await RPC.orpc.settings.server.updateSettings.call({
				serverId: stores.squadServer.serverId,
				ops: [{ path: [...TSWCB.ENABLED_SETTING_PATH], value: enabled }],
			})
			if (res?.code === 'err:permission-denied') RbacClient.handlePermissionDenied(res)
			else if (res?.code === 'err:invalid-settings') toast.error(...tr.toast(SETTINGS_Msgs.invalid(res.message)))
		} catch (err) {
			toast.error(...tr.toast(SETTINGS_Msgs.saveFailed(err instanceof Error ? err.message : String(err))))
		}
	}
}
