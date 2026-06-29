import * as RbSyncState from '@/lib/rollback-synced-state'
import * as MH from '@/models/match-history.models'
import * as SquadServer from '@/models/squad-server.models'
import * as SM from '@/models/squad.models'
import * as Teamswitches from '@/models/teamswitches.models'
import * as RPC from '@/orpc.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as UsersClient from '@/systems/users.client'
import * as Zus from 'zustand'

import { assertNever } from '@/lib/type-guards'
import * as ReactRx from '@react-rxjs/core'
import * as Rx from 'rxjs'

export type Store = {
	session: RbSyncState.Client.Session<Teamswitches.Op, Teamswitches.State, Teamswitches.SideEffect>
	onUpdate(update: Teamswitches.UpdateForClient): void
	dispatch(newOp: Teamswitches.NewClientOp): void
}

const [useUpdate, update$] = ReactRx.bind(RPC.observe(() => RPC.orpc.teamswitches.watchUpdates.call()))

function onSideEffect(se: Teamswitches.SideEffect) {
	console.log('teamswitch side effect', se)
}
function initSession(state?: Teamswitches.State, ops?: Teamswitches.Op[]) {
	return RbSyncState.Client.initSession<Teamswitches.Op, Teamswitches.State, Teamswitches.SideEffect>(state ?? Teamswitches.initState(), {
		onSideEffect,
		ops,
	})
}

export const Store = Zus.createStore<Store>((set, get) => {
	return {
		session: initSession(),

		dispatch(newOp) {
			const op = { ...newOp, opId: Teamswitches.createOpId() }
			const updated = RbSyncState.Client.processOutgoingOps(get().session, [op], Teamswitches.reducer)
			set({ session: updated })
			console.log('teamswitch dispatch', op.code, op.opId)
			void RPC.orpc.teamswitches.dispatchOp.call(op)
		},

		onUpdate(update) {
			switch (update.code) {
				case 'init':
					console.log('teamswitch init', update.state, update.ops)
					set({
						session: initSession(update.state, update.ops),
					})
					break
				case 'op':
					for (const op of update.ops) {
						console.log('teamswitch receive', op.code, op.opId)
					}
					const updated = RbSyncState.Client.processIncomingOps(get().session, update.ops, Teamswitches.reducer)
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
			for (const switch_ of state.switches.values()) {
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
		return localState(store).switches.size > 0
	}

	export function canExecuteSavedTeamswitches(store: Store) {
		return Teamswitches.canExecuteSavedTeamswitches(localState(store))
	}

	export function hasPendingEdits(store: Store) {
		const state = localState(store)
		return state.switches !== state.savedSwitches
	}

	export function switchCounts(store: Store) {
		const state = localState(store)
		const counts: Record<MH.NormedTeamId, number> = { A: 0, B: 0 }
		for (const switch_ of state.switches.values()) {
			counts[switch_.toTeam]++
		}
		return counts
	}

	export function canSwitchNow(playerIds: SM.PlayerId[]) {
		return (store: Store) => Teamswitches.allCanSwitchNow(localState(store), playerIds)
	}

	export function canQueue(playerIds: SM.PlayerId[]) {
		return (store: Store) => Teamswitches.allCanQueue(localState(store), playerIds)
	}

	export function isSwitchPending(playerId: SM.PlayerId) {
		return (store: Store) => Teamswitches.isSwitchPending(localState(store), playerId)
	}

	export function switchesToTeamEnriched(
		store: Store,
		chatStore: SquadServer.ChatStore,
		team: MH.NormedTeamId,
	): Map<SM.PlayerId, Teamswitches.EnrichedTeamswitch> {
		const switches = localState(store).switches
		const players = SquadServer.Select.chatState(chatStore).players
		const result: Map<SM.PlayerId, Teamswitches.EnrichedTeamswitch> = new Map()
		for (const [playerId, switch_] of switches.entries()) {
			if (switch_.toTeam !== team) continue
			const player = SM.PlayerIds.find(players, p => p.ids, playerId)
			if (!player) continue
			result.set(playerId, { ...switch_, player })
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
	export function switchNext(playerIds: SM.PlayerId[]) {
		const source = { discordId: UsersClient.loggedInUserId }
		for (const playerId of playerIds) {
			const toTeam = getPlayerOppositeTeam(playerId)
			if (!toTeam) continue
			Store.getState().dispatch({ code: 'add-player-teamswitch', playerId, toTeam, source, saved: false })
		}
	}

	export function removeSwitch(playerIds: SM.PlayerId[]) {
		const source = { discordId: UsersClient.loggedInUserId }
		for (const playerId of playerIds) {
			Store.getState().dispatch({ code: 'remove-player-teamswitches', playerId, source, saved: false })
		}
	}

	export function switchNow(playerIds: SM.PlayerId[]) {
		const source = { discordId: UsersClient.loggedInUserId }
		const switches: Teamswitches.TeamswitchCollection = new Map()
		for (const playerId of playerIds) {
			const toTeam = getPlayerOppositeTeam(playerId)
			if (!toTeam) continue
			switches.set(playerId, { toTeam, source })
		}
		if (switches.size > 0) Store.getState().dispatch({ code: 'switch-now', switches, source })
	}

	export function clearTeamSwitches(teamId: MH.NormedTeamId) {
		const source = { discordId: UsersClient.loggedInUserId }
		const state = Select.localState(Store.getState())
		for (const [playerId, switch_] of state.switches.entries()) {
			if (switch_.toTeam !== teamId) continue
			Store.getState().dispatch({ code: 'remove-player-teamswitches', playerId, source, saved: false })
		}
	}

	export function executeTeamswitches() {
		const source = { discordId: UsersClient.loggedInUserId }
		Store.getState().dispatch({ code: 'execute-teamswitches', source })
	}

	export function save() {
		Store.getState().dispatch({ code: 'save' })
	}
}

export function setup() {
	update$.subscribe(update => {
		Store.getState().onUpdate(update)
	})
}
