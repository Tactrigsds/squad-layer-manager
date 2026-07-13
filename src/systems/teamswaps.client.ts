import * as ChatPrt from '@/frame-partials/chat.partial'
import * as TSWPrt from '@/frame-partials/teamswaps.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as ItemMutations from '@/lib/item-mutations'
import * as Obj from '@/lib/object'
import * as ZusUtils from '@/lib/zustand'
import type * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import * as TSW from '@/models/teamswaps.models'
import * as UP from '@/models/user-presence'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'

export type Store = TSWPrt.Store

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

	export function isSwapPending(playerId: SM.PlayerId): (store: Store) => boolean {
		return (store: Store) => TSW.isSwapPending(localState(store), playerId)
	}

	export function swapsToTeamEnriched(
		store: Store & ChatPrt.Store,
		team: MH.NormedTeamId,
	): Map<SM.PlayerId, TSW.EnrichedTeamswap> {
		const swaps = localState(store).editedSwaps
		const players = ChatPrt.Sel.chatState(store).players
		const result: Map<SM.PlayerId, TSW.EnrichedTeamswap> = new Map()
		for (const [playerId, swap_] of swaps.entries()) {
			if (swap_.toTeam !== team) continue
			const player = SM.PlayerIds.find(players, p => p.ids, playerId)
			if (!player) continue
			result.set(playerId, { ...swap_, player })
		}
		return result
	}

	export type EnrichedTeamswapWithMutation = TSW.EnrichedTeamswap & {
		mutation: ItemMutations.ItemMutationState
	}

	export function swapsToTeamEnrichedWithMutations(
		store: Store & ChatPrt.Store,
		team: MH.NormedTeamId,
	): Map<SM.PlayerId, EnrichedTeamswapWithMutation> {
		const { editedSwaps: swaps, savedSwaps } = localState(store)
		const players = ChatPrt.Sel.chatState(store).players

		const mutations = ItemMutations.initMutations<SM.PlayerId>()
		const allPlayerIds = new Set<SM.PlayerId>()

		for (const [playerId, swap_] of swaps.entries()) {
			if (swap_.toTeam !== team) continue
			allPlayerIds.add(playerId)
			if (!savedSwaps.has(playerId)) {
				ItemMutations.tryApplyMutation('added', playerId, mutations)
			}
		}
		for (const [playerId, swap_] of savedSwaps.entries()) {
			if (swap_.toTeam !== team) continue
			allPlayerIds.add(playerId)
			if (!swaps.has(playerId)) {
				ItemMutations.tryApplyMutation('removed', playerId, mutations)
			}
		}

		const result = new Map<SM.PlayerId, EnrichedTeamswapWithMutation>()
		for (const playerId of allPlayerIds) {
			const swap_ = swaps.get(playerId) ?? savedSwaps.get(playerId)!
			const player = SM.PlayerIds.find(players, p => p.ids, playerId)
			if (!player) continue
			result.set(playerId, { ...swap_, player, mutation: ItemMutations.toItemMutationState(mutations, playerId) })
		}
		return result
	}
}

function getPlayerOppositeTeam(stores: SquadServerFrame.KeyProp, playerId: SM.PlayerId): MH.NormedTeamId | null {
	const matchesResult = MatchHistoryClient.recentMatches$(stores.squadServer.serverId).getValue()
	if (matchesResult instanceof Promise) return null
	const currentMatch = matchesResult[matchesResult.length - 1] as MH.MatchDetails | undefined
	const state = ZusUtils.getState(stores.squadServer)
	const players = ChatPrt.Sel.chatState(state).players
	return TSWPrt.getPlayerOppositeTeam(playerId, currentMatch, players)
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
		const state = Sel.localState(ZusUtils.getState(stores.squadServer))
		for (const playerId of playerIds) {
			if (!TSW.canQueue(state, playerId)) continue
			const toTeam = getPlayerOppositeTeam(stores, playerId)
			if (!toTeam) continue
			TSWPrt.Actions.dispatch({ teamswaps: stores.squadServer }, {
				code: 'add-player-teamswap',
				playerId,
				toTeam,
				source,
				saved: false,
			})
		}
		setEditing(stores.squadServer.serverId)
	}

	export function removeSwap(stores: SquadServerFrame.KeyProp, playerIds: SM.PlayerId[]) {
		const source = { discordId: UsersClient.loggedInUserId }
		for (const playerId of playerIds) {
			TSWPrt.Actions.dispatch({ teamswaps: stores.squadServer }, { code: 'remove-player-teamswaps', playerId, source, saved: false })
		}
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
			TSWPrt.Actions.dispatch({ teamswaps: stores.squadServer }, { code: 'swap-now', swaps, source })
		}
	}

	export function clearTeamSwaps(stores: SquadServerFrame.KeyProp, teamId: MH.NormedTeamId) {
		const source = { discordId: UsersClient.loggedInUserId }
		const state = Sel.localState(ZusUtils.getState(stores.squadServer))
		for (const [playerId, swap_] of state.editedSwaps.entries()) {
			if (swap_.toTeam !== teamId) continue
			TSWPrt.Actions.dispatch({ teamswaps: stores.squadServer }, { code: 'remove-player-teamswaps', playerId, source, saved: false })
		}
		setEditing(stores.squadServer.serverId)
	}

	export function executeTeamswaps(stores: SquadServerFrame.KeyProp) {
		ensureViewingTeams(stores.squadServer.serverId)
		const source = { discordId: UsersClient.loggedInUserId }
		TSWPrt.Actions.dispatch({ teamswaps: stores.squadServer }, { code: 'execute-teamswaps', source })
	}

	export function save(stores: SquadServerFrame.KeyProp) {
		const source = { discordId: UsersClient.loggedInUserId }
		TSWPrt.Actions.dispatch({ teamswaps: stores.squadServer }, { code: 'save', source })
	}

	export function revertToSaved(stores: SquadServerFrame.KeyProp) {
		ensureViewingTeams(stores.squadServer.serverId)
		const source = { discordId: UsersClient.loggedInUserId }
		TSWPrt.Actions.dispatch({ teamswaps: stores.squadServer }, { code: 'revert-to-saved', source })
		clearEditing(stores.squadServer.serverId)
	}
}
