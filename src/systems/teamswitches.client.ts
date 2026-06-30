import { toast } from '@/hooks/use-toast'
import * as ItemMutations from '@/lib/item-mutations'
import * as Obj from '@/lib/object'
import * as RbSyncState from '@/lib/rollback-synced-state'
import { assertNever } from '@/lib/type-guards'
import * as MH from '@/models/match-history.models'
import * as SquadServer from '@/models/squad-server.models'
import * as SM from '@/models/squad.models'
import * as TSW from '@/models/teamswitches.models'
import * as UP from '@/models/user-presence'
import * as RPC from '@/orpc.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'
import * as ReactRx from '@react-rxjs/core'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'

export type Store = {
	session: RbSyncState.Client.Session<TSW.Op, TSW.State, TSW.SideEffect>
	onUpdate(update: TSW.UpdateForClient): void
	dispatch(newOp: TSW.NewClientOp): void
}

const [useUpdate, update$] = ReactRx.bind(RPC.observe(() => RPC.orpc.teamswitches.watchUpdates.call()))

async function resolveDisplayName(source: TSW.Teamswitch['source'] | undefined): Promise<string> {
	const discordId = source?.discordId
	if (!discordId) return 'Someone'
	try {
		const res = await RPC.queryClient.fetchQuery(UsersClient.getFetchUserOptions(discordId))
		return res?.code === 'ok' ? res.user.displayName : 'Someone'
	} catch {
		return 'Someone'
	}
}

function onSideEffect(se: TSW.SideEffect) {
	switch (se.code) {
		case 'error': {
			const userId = UsersClient.loggedInUserId
			if (!userId) return
			if ((se.error.op as any).source?.discordId !== userId) return
			const { error } = se
			let title: string
			let description: string | undefined
			switch (error.code) {
				case 'err:currently-switching':
					title = 'Switch in progress'
					description = 'Cannot modify switches while a team switch is being executed.'
					break
				case 'err:switches-not-saved':
					title = 'Switches not saved'
					description = 'Save your switches before executing.'
					break
				case 'err:pending-switch':
					title = 'Player switch pending'
					description = `A switch for this player is already pending execution.`
					break
				case 'err:teamswitch-execution-failed':
					title = 'Team switch failed'
					description = error.reason === 'not-all-players-switched'
						? 'Some players could not be switched to their assigned teams.'
						: 'An error occurred while executing the team switch.'
					break
				case 'err:currently-not-switching':
				case 'err:unexpected':
					title = 'Unexpected error'
					description = 'An unexpected error occurred with the team switch system.'
					break
				default:
					return
			}
			toast({ variant: 'destructive', title, description })
			break
		}

		case 'save': {
			if (!se.source) break
			const { source, switches } = se
			void resolveDisplayName(source).then((name) => {
				const count = switches.size
				const description = count > 0
					? `${name} saved ${count} teamswitch${count !== 1 ? 'es' : ''}.`
					: `${name} cleared the saved teamswitches.`
				toast({ title: 'Teamswitches saved', description })
			})
			break
		}

		case 'teamswitches-executed': {
			const { source, switchCount } = se
			void resolveDisplayName(source).then((name) => {
				const description = `${name} switched ${switchCount} player${switchCount !== 1 ? 's' : ''} to their assigned teams.`
				toast({ title: 'Teamswitches executed', description })
			})
			break
		}

		default:
			break
	}
}
function initSession(state?: TSW.State, ops?: TSW.Op[]) {
	return RbSyncState.Client.initSession<TSW.Op, TSW.State, TSW.SideEffect>(state ?? TSW.initState(), {
		onSideEffect,
		ops,
	})
}

export const Store = Zus.createStore<Store>((set, get) => {
	return {
		session: initSession(),

		dispatch(newOp) {
			const op = { ...newOp, opId: TSW.createOpId() }
			const updated = RbSyncState.Client.processOutgoingOps(get().session, [op], TSW.reducer)
			set({ session: updated })
			void RPC.orpc.teamswitches.dispatchOp.call(op)
		},

		onUpdate(update) {
			switch (update.code) {
				case 'init':
					set({
						session: initSession(update.state, update.ops),
					})
					break
				case 'op':
					const updated = RbSyncState.Client.processIncomingOps(get().session, update.ops, TSW.reducer)
					set({ session: updated })
					break
				default:
					assertNever(update)
			}
		},
	}
})

export namespace Select {
	export function localState(store: Store) {
		return store.session.localState
	}

	export function diffAfterSwitchesForTeam(team: MH.NormedTeamId) {
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

	export function hasPendingEdits(store: Store) {
		const state = localState(store)
		return state.editedSwitches !== state.savedSwitches
	}

	export function switchCounts(store: Store) {
		const state = localState(store)
		const counts: Record<MH.NormedTeamId, number> = { A: 0, B: 0 }
		for (const switch_ of state.editedSwitches.values()) {
			counts[switch_.toTeam]++
		}
		return counts
	}

	export function canSwitchNow(playerIds: SM.PlayerId[]) {
		return (store: Store) => TSW.allCanSwitchNow(localState(store), playerIds)
	}

	export function canQueue(playerIds: SM.PlayerId[]) {
		return (store: Store) => TSW.allCanQueue(localState(store), playerIds)
	}

	export function isSwitchPending(playerId: SM.PlayerId) {
		return (store: Store) => TSW.isSwitchPending(localState(store), playerId)
	}

	export function switchesToTeamEnriched(
		store: Store,
		chatStore: SquadServer.ChatStore,
		team: MH.NormedTeamId,
	): Map<SM.PlayerId, TSW.EnrichedTeamswitch> {
		const switches = localState(store).editedSwitches
		const players = SquadServer.Select.chatState(chatStore).players
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
		store: Store,
		chatStore: SquadServer.ChatStore,
		team: MH.NormedTeamId,
	): Map<SM.PlayerId, EnrichedTeamswitchWithMutation> {
		const { editedSwitches: switches, savedSwitches } = localState(store)
		const players = SquadServer.Select.chatState(chatStore).players

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

function getPlayerOppositeTeam(playerId: SM.PlayerId): MH.NormedTeamId | null {
	const matchesResult = MatchHistoryClient.recentMatches$.getValue()
	if (matchesResult instanceof Promise) return null
	const currentMatch = matchesResult[matchesResult.length - 1] as MH.MatchDetails | undefined
	if (!currentMatch) return null
	const chatState = SquadServer.Select.chatState(SquadServerClient.ChatStore.getState())
	const player = SM.PlayerIds.find(chatState.players, p => p.ids, playerId)
	if (!player?.teamId) return null
	const normed = MH.getNormedTeamId(player.teamId, currentMatch.ordinal)
	return normed === 'A' ? 'B' : 'A'
}

export namespace Actions {
	export function ensureViewingTeams() {
		UPClient.Store.getState().updateActivity(UP.VIEWING_TEAMS_TRANSITIONS.createActivity())
	}

	function setEditing() {
		UPClient.Store.getState().updateActivity(UP.EDITING_TEAMSWITCHES_TRANSITIONS.createActivity())
	}
	function clearEditing() {
		UPClient.Store.getState().updateActivity(UP.EDITING_TEAMSWITCHES_TRANSITIONS.removeActivity())
	}

	export function switchNext(playerIds: SM.PlayerId[]) {
		const source = { discordId: UsersClient.loggedInUserId }
		for (const playerId of playerIds) {
			const toTeam = getPlayerOppositeTeam(playerId)
			if (!toTeam) continue
			Store.getState().dispatch({ code: 'add-player-teamswitch', playerId, toTeam, source, saved: false })
		}
		setEditing()
	}

	export function removeSwitch(playerIds: SM.PlayerId[]) {
		const source = { discordId: UsersClient.loggedInUserId }
		for (const playerId of playerIds) {
			Store.getState().dispatch({ code: 'remove-player-teamswitches', playerId, source, saved: false })
		}
		setEditing()
	}

	export function switchNow(playerIds: SM.PlayerId[]) {
		const source = { discordId: UsersClient.loggedInUserId }
		const switches: TSW.TeamswitchCollection = new Map()
		for (const playerId of playerIds) {
			const toTeam = getPlayerOppositeTeam(playerId)
			if (!toTeam) continue
			switches.set(playerId, { toTeam, source })
		}
		if (switches.size > 0) {
			ensureViewingTeams()
			Store.getState().dispatch({ code: 'switch-now', switches, source })
		}
	}

	export function clearTeamSwitches(teamId: MH.NormedTeamId) {
		const source = { discordId: UsersClient.loggedInUserId }
		const state = Select.localState(Store.getState())
		for (const [playerId, switch_] of state.editedSwitches.entries()) {
			if (switch_.toTeam !== teamId) continue
			Store.getState().dispatch({ code: 'remove-player-teamswitches', playerId, source, saved: false })
		}
		setEditing()
	}

	export function executeTeamswitches() {
		ensureViewingTeams()
		const source = { discordId: UsersClient.loggedInUserId }
		Store.getState().dispatch({ code: 'execute-teamswitches', source })
	}

	export function save() {
		const source = { discordId: UsersClient.loggedInUserId }
		Store.getState().dispatch({ code: 'save', source })
	}

	export function revertToSaved() {
		ensureViewingTeams()
		const source = { discordId: UsersClient.loggedInUserId }
		Store.getState().dispatch({ code: 'revert-to-saved', source })
		clearEditing()
	}
}

export function setup() {
	update$.subscribe(update => {
		Store.getState().onUpdate(update)
	})
}
