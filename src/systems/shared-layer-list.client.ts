import { globalToast$ } from '@/hooks/use-global-toast'
import { createId } from '@/lib/id'
import type * as ItemMut from '@/lib/item-mutations'
import * as Obj from '@/lib/object'
import * as RbSyncState from '@/lib/rollback-synced-state'
import { assertNever } from '@/lib/type-guards'
import * as ZusUtils from '@/lib/zustand'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as SLL from '@/models/shared-layer-list'
import * as UP from '@/models/user-presence'
import * as RPC from '@/orpc.client'
import * as RbacClient from '@/systems/rbac.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'
import * as VotesClient from '@/systems/vote.client'
import * as ReactRx from '@react-rxjs/core'
import * as Im from 'immer'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'

export type Store = {
	rbSession: RbSyncState.Client.Session<SLL.Operation, SLL.State, SLL.SideEffect>

	handleServerUpdate(update: SLL.Update): void
	dispatch(op: SLL.NewClientOperation): Promise<void>
	writeIncomingOperations(ops: SLL.Operation[]): void

	syncedOp$: Rx.Subject<SLL.Operation>
	committing: boolean

	// -------- derived properties --------
	layerList: LL.Item[]
	mutations: ItemMut.Mutations
	isModified: boolean
}

const [_useServerUpdate, serverUpdate$] = ReactRx.bind<SLL.Update>(
	RPC.observe(() => RPC.orpc.layerQueue.watchOps.call()),
)

export const Store = createStore()

function createStore() {
	const initRbSession = RbSyncState.Client.initSession<SLL.Operation, SLL.State, SLL.SideEffect>(SLL.createNewState())

	const store = Zus.createStore<Store>((set, get, store) => {
		store.subscribe((state, prev) => {
			const localState = state.rbSession.localState
			const prevLocalState = prev.rbSession.localState
			if (localState === prevLocalState) return

			const updates: Partial<Store> = {}
			if (localState.saving !== state.committing) updates.committing = localState.saving
			if (localState.list !== state.layerList) updates.layerList = localState.list
			if (localState.mutations !== state.mutations) updates.mutations = localState.mutations
			const hasMutations = SLL.hasMutations(localState)
			if (hasMutations !== state.isModified) updates.isModified = hasMutations
			if (Object.keys(updates).length > 0) set(updates)
		})

		return {
			rbSession: initRbSession,

			syncedOp$: new Rx.Subject(),

			// derived
			layerList: initRbSession.localState.list,
			mutations: initRbSession.localState.mutations,
			committing: false,
			isModified: false,

			async handleServerUpdate(update) {
				switch (update.code) {
					case 'init': {
						const newRbSession = RbSyncState.Client.initSession<SLL.Operation, SLL.State, SLL.SideEffect>(update.state)
						set({
							rbSession: newRbSession,
						})
						break
					}
					case 'op': {
						get().writeIncomingOperations([update.op])
						break
					}
					// case 'update-presence': {
					// 	if (update.sideEffectOps) this.writeIncomingOperations(update.sideEffectOps)
					// 	break
					// }

					// case 'reset-completed':
					// case 'list-updated':
					// case 'commit-completed': {
					// 	set({ committing: false })
					// 	if (update.code === 'list-updated') {
					// 		globalToast$.next({ title: 'Queue Updated' })
					// 	} else {
					// 		const msg = `Queue ${update.code === 'commit-completed' ? 'updated' : 'reset'} by ${update.initiator}`
					// 		globalToast$.next({ title: msg })
					// 	}
					// 	const prevOps = RbSyncState.Client.localOps(get().rbSession)
					// 	const newSession = SLL.createNewState(update.list)
					// 	const newRbSession = RbSyncState.Client.initSession<SLL.Operation, SLL.State>(newSession)
					// 	set({
					// 		rbSession: newRbSession,
					// 		sessionSeqId: update.newSessionSeqId,
					// 		itemLocks: new Map(),
					// 	})
					// 	UPClient.PresenceStore.getState().onSessionChanged(prevOps)
					// 	break
					// }

					// case 'commit-rejected': {
					// 	set({ committing: false })
					// 	globalToast$.next({ variant: 'destructive', title: update.msg })
					// 	break
					// }

					// case 'locks-modified': {
					// 	set(state =>
					// 		Im.produce(state, draft => {
					// 			for (const [itemId, wsClientId] of update.mutations) {
					// 				if (wsClientId === null) draft.itemLocks.delete(itemId)
					// 				else draft.itemLocks.set(itemId, wsClientId)
					// 			}
					// 		})
					// 	)
					// 	break
					// }

					// case 'commit':
					// case 'reset':
					// 	set({ committing: false })
					// 	break

					// case 'commit-started': {
					// 	set({ committing: true })
					// 	break
					// }

					default:
						assertNever(update)
				}
			},

			writeIncomingOperations(ops: SLL.Operation[]) {
				const newRbSession = RbSyncState.Client.processIncomingOps(get().rbSession, ops, SLL.reducer)
				set({ rbSession: newRbSession })
				for (const op of ops) {
					get().syncedOp$.next(op)
				}
			},

			// try to call this such that react will batch the rerenders
			async dispatch(newOp) {
				const userId = UsersClient.loggedInUserId!
				const editWindowSeqId = get().rbSession.localState.editWindowSeqId
				const baseProps = { opId: SLL.createOpId(), userId, editWindowSeqId }

				let op: SLL.Operation
				const source: LL.Source = { type: 'manual', userId }
				switch (newOp.op) {
					case 'add': {
						const items = newOp.items.map(item => LL.createItem(item, source))
						op = {
							op: 'add',
							index: newOp.index,
							items,
							...baseProps,
						}
						break
					}
					default: {
						op = {
							...newOp,
							...baseProps,
						}
						break
					}
				}
				console.log(op)

				set({ rbSession: RbSyncState.Client.processOutgoingOps(get().rbSession, [op], SLL.reducer) })

				const res = await RPC.orpc.layerQueue.dispatchOp.call(op)
				if (res.code === 'err:permission-denied') {
					RbacClient.handlePermissionDenied(res)
					return
				} else if (res.code !== 'ok') {
					globalToast$.next({ variant: 'destructive', title: res.msg })
				}
			},
		}
	})

	return store
}

export async function setup() {
	serverUpdate$.subscribe(update => {
		Store.getState().handleServerUpdate(update)
	})
}

// suppress unused reference warnings for items only accessed via types
void _useServerUpdate
void ZusUtils
void L
