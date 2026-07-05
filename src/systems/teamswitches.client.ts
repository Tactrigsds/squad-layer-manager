import * as ChatPrt from '@/frame-partials/chat.partial'
import * as TSWPrt from '@/frame-partials/teamswitches.partial'
import type * as SquadServerFrame from '@/frames/squad-server.frame'
import * as ItemMutations from '@/lib/item-mutations'
import * as Obj from '@/lib/object'
import * as ZusUtils from '@/lib/zustand'
import type * as MH from '@/models/match-history.models'
import * as SM from '@/models/squad.models'
import * as TSW from '@/models/teamswitches.models'
import * as UP from '@/models/user-presence'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'

export type Store = TSWPrt.Store

export namespace Sel {
	export function localState(store: Store) {
		return store.teamswitches.session.localState
	}

	export function diffAfterSwitchesForTeam(team: MH.NormedTeamId): (store: Store) => number {
		return (store: Store) => {
			const state = localState(store)
			let count = 0
			for (const switch_ of state.editedSwitches.values()) {
				if (switch_.toTeam === team) {
					count++
				} else {
					count--
				}
			}
			return count
		}
	}

	export function hasSwitches(store: Store) {
		return localState(store).editedSwitches.size > 0 || localState(store).savedSwitches.size > 0
	}

	export function switchesModified(store: Store) {
		const state = localState(store)
		return !Obj.deepEqual(state.editedSwitches, state.savedSwitches)
	}

	export function canExecuteSavedTeamswitches(store: Store) {
		return TSW.canExecuteSavedTeamswitches(localState(store))
	}

	export function switchCounts(store: Store) {
		const state = localState(store)
		const counts: Record<MH.NormedTeamId, number> = { A: 0, B: 0 }
		for (const switch_ of state.editedSwitches.values()) {
			counts[switch_.toTeam]++
		}
		return counts
	}

	export function canSwitchNow(playerIds: SM.PlayerId[]): (store: Store) => boolean {
		return (store: Store) => TSW.allCanSwitchNow(localState(store), playerIds)
	}

	export function canQueue(playerIds: SM.PlayerId[]): (store: Store) => boolean {
		return (store: Store) => TSW.allCanQueue(localState(store), playerIds)
	}

	export function someCanQueue(playerIds: SM.PlayerId[]): (store: Store) => boolean {
		return (store: Store) => TSW.someCanQueue(localState(store), playerIds)
	}

	export function isSwitchPending(playerId: SM.PlayerId): (store: Store) => boolean {
		return (store: Store) => TSW.isSwitchPending(localState(store), playerId)
	}

	export function switchesToTeamEnriched(
		store: Store & ChatPrt.Store,
		team: MH.NormedTeamId,
	): Map<SM.PlayerId, TSW.EnrichedTeamswitch> {
		const switches = localState(store).editedSwitches
		const players = ChatPrt.Sel.chatState(store).players
		const result: Map<SM.PlayerId, TSW.EnrichedTeamswitch> = new Map()
		for (const [playerId, switch_] of switches.entries()) {
			if (switch_.toTeam !== team) continue
			const player = SM.PlayerIds.find(players, p => p.ids, playerId)
			if (!player) continue
			result.set(playerId, { ...switch_, player })
		}
		return result
	}

	export type EnrichedTeamswitchWithMutation = TSW.EnrichedTeamswitch & {
		mutation: ItemMutations.ItemMutationState
	}

	export function switchesToTeamEnrichedWithMutations(
		store: Store & ChatPrt.Store,
		team: MH.NormedTeamId,
	): Map<SM.PlayerId, EnrichedTeamswitchWithMutation> {
		const { editedSwitches: switches, savedSwitches } = localState(store)
		const players = ChatPrt.Sel.chatState(store).players

		const mutations = ItemMutations.initMutations<SM.PlayerId>()
		const allPlayerIds = new Set<SM.PlayerId>()

		for (const [playerId, switch_] of switches.entries()) {
			if (switch_.toTeam !== team) continue
			allPlayerIds.add(playerId)
			if (!savedSwitches.has(playerId)) {
				ItemMutations.tryApplyMutation('added', playerId, mutations)
			}
		}
		for (const [playerId, switch_] of savedSwitches.entries()) {
			if (switch_.toTeam !== team) continue
			allPlayerIds.add(playerId)
			if (!switches.has(playerId)) {
				ItemMutations.tryApplyMutation('removed', playerId, mutations)
			}
		}

		const result = new Map<SM.PlayerId, EnrichedTeamswitchWithMutation>()
		for (const playerId of allPlayerIds) {
			const switch_ = switches.get(playerId) ?? savedSwitches.get(playerId)!
			const player = SM.PlayerIds.find(players, p => p.ids, playerId)
			if (!player) continue
			result.set(playerId, { ...switch_, player, mutation: ItemMutations.toItemMutationState(mutations, playerId) })
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
		UPClient.Actions.updateActivity(UP.Trans.editingTeamswitches(serverId).create())
	}
	function clearEditing(serverId: string) {
		UPClient.Actions.updateActivity(UP.Trans.editingTeamswitches(serverId).destroy())
	}

	export function switchNext(stores: SquadServerFrame.KeyProp, playerIds: SM.PlayerId[]) {
		const source = { discordId: UsersClient.loggedInUserId }
		const state = Sel.localState(ZusUtils.getState(stores.squadServer))
		for (const playerId of playerIds) {
			if (!TSW.canQueue(state, playerId)) continue
			const toTeam = getPlayerOppositeTeam(stores, playerId)
			if (!toTeam) continue
			TSWPrt.Actions.dispatch({ teamswitches: stores.squadServer }, {
				code: 'add-player-teamswitch',
				playerId,
				toTeam,
				source,
				saved: false,
			})
		}
		setEditing(stores.squadServer.serverId)
	}

	export function removeSwitch(stores: SquadServerFrame.KeyProp, playerIds: SM.PlayerId[]) {
		const source = { discordId: UsersClient.loggedInUserId }
		for (const playerId of playerIds) {
			TSWPrt.Actions.dispatch({ teamswitches: stores.squadServer }, { code: 'remove-player-teamswitches', playerId, source, saved: false })
		}
		setEditing(stores.squadServer.serverId)
	}

	export function switchNow(stores: SquadServerFrame.KeyProp, playerIds: SM.PlayerId[]) {
		const source = { discordId: UsersClient.loggedInUserId }
		const switches: TSW.TeamswitchCollection = new Map()
		for (const playerId of playerIds) {
			const toTeam = getPlayerOppositeTeam(stores, playerId)
			if (!toTeam) continue
			switches.set(playerId, { toTeam, source })
		}
		if (switches.size > 0) {
			ensureViewingTeams(stores.squadServer.serverId)
			TSWPrt.Actions.dispatch({ teamswitches: stores.squadServer }, { code: 'switch-now', switches, source })
		}
	}

	export function clearTeamSwitches(stores: SquadServerFrame.KeyProp, teamId: MH.NormedTeamId) {
		const source = { discordId: UsersClient.loggedInUserId }
		const state = Sel.localState(ZusUtils.getState(stores.squadServer))
		for (const [playerId, switch_] of state.editedSwitches.entries()) {
			if (switch_.toTeam !== teamId) continue
			TSWPrt.Actions.dispatch({ teamswitches: stores.squadServer }, { code: 'remove-player-teamswitches', playerId, source, saved: false })
		}
		setEditing(stores.squadServer.serverId)
	}

	export function executeTeamswitches(stores: SquadServerFrame.KeyProp) {
		ensureViewingTeams(stores.squadServer.serverId)
		const source = { discordId: UsersClient.loggedInUserId }
		TSWPrt.Actions.dispatch({ teamswitches: stores.squadServer }, { code: 'execute-teamswitches', source })
	}

	export function save(stores: SquadServerFrame.KeyProp) {
		const source = { discordId: UsersClient.loggedInUserId }
		TSWPrt.Actions.dispatch({ teamswitches: stores.squadServer }, { code: 'save', source })
	}

	export function revertToSaved(stores: SquadServerFrame.KeyProp) {
		ensureViewingTeams(stores.squadServer.serverId)
		const source = { discordId: UsersClient.loggedInUserId }
		TSWPrt.Actions.dispatch({ teamswitches: stores.squadServer }, { code: 'revert-to-saved', source })
		clearEditing(stores.squadServer.serverId)
	}
}
