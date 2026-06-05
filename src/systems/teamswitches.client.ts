import * as RbSyncState from '@/lib/rollback-synced-state'
import * as MH from '@/models/match-history.models'
import * as Teamswitches from '@/models/teamswitches.models'
import * as RPC from '@/orpc.client'
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
			RbSyncState.Client.processOutgoingOps(get().session, [op], Teamswitches.reducer)
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
					RbSyncState.Client.processIncomingOps(get().session, [update.op], Teamswitches.reducer)
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
}

export function setup() {
	update$.subscribe(update => {
		Store.getState().onUpdate(update)
	})
}
