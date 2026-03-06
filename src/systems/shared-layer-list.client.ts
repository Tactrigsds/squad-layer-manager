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
	sessionSeqId: SLL.SessionSequenceId

	rbSession: RbSyncState.Client.Session<SLL.Operation, SLL.EditSession>

	itemLocks: SLL.ItemLocks

	handleServerUpdate(update: SLL.Update): void
	dispatch(op: SLL.NewOperation): Promise<void>
	writeIncomingOperations(ops: SLL.Operation[]): void

	syncedOp$: Rx.Subject<SLL.Operation>
	committing: boolean

	reset(): Promise<void>

	// -------- derived properties --------
	layerList: LL.Item[]
	editors: SLL.EditSession['editors']
	mutations: ItemMut.Mutations
	isModified: boolean
}

const sllReducer: RbSyncState.Reducer<SLL.Operation, SLL.EditSession> = (state, ops) => {
	const next = Obj.deepClone(state)
	const batchMutations = SLL.applyOperations(next, ops)
	next.mutations = SLL.mergeMutations(next.mutations, batchMutations)
	return next
}

const [_useServerUpdate, serverUpdate$] = ReactRx.bind<SLL.Update>(
	RPC.observe(() => RPC.orpc.sharedLayerList.watchUpdates.call()),
)

export const Store = createStore()

function createStore() {
	const initRbSession = RbSyncState.Client.initSession<SLL.Operation, SLL.EditSession>(SLL.createNewSession())

	const store = Zus.createStore<Store>((set, get, store) => {
		store.subscribe((state, prev) => {
			const localState = state.rbSession.localState
			const prevLocalState = prev.rbSession.localState
			if (localState === prevLocalState) return

			const updates: Partial<Store> = {}
			if (localState.list !== state.layerList) updates.layerList = localState.list
			if (localState.editors !== state.editors) updates.editors = localState.editors
			if (localState.mutations !== state.mutations) updates.mutations = localState.mutations
			const hasMutations = SLL.hasMutations(localState)
			if (hasMutations !== state.isModified) updates.isModified = hasMutations
			if (Object.keys(updates).length > 0) set(updates)
		})

		return {
			rbSession: initRbSession,

			sessionSeqId: 0,
			itemLocks: new Map(),

			committing: false,
			syncedOp$: new Rx.Subject(),

			// derived
			layerList: initRbSession.localState.list,
			editors: initRbSession.localState.editors,
			mutations: initRbSession.localState.mutations,
			isModified: false,

			async handleServerUpdate(update) {
				switch (update.code) {
					case 'init': {
						const newRbSession = RbSyncState.Client.initSession<SLL.Operation, SLL.EditSession>(update.session)
						set({
							...store.getInitialState(),
							rbSession: newRbSession,
							sessionSeqId: update.sessionSeqId,
							itemLocks: new Map(),
						})
						break
					}
					case 'op': {
						get().writeIncomingOperations([update.op])
						break
					}
					case 'update-presence': {
						if (update.sideEffectOps) this.writeIncomingOperations(update.sideEffectOps)
						break
					}

					case 'reset-completed':
					case 'list-updated':
					case 'commit-completed': {
						set({ committing: false })
						if (update.code === 'list-updated') {
							globalToast$.next({ title: 'Queue Updated' })
						} else {
							const msg = `Queue ${update.code === 'commit-completed' ? 'updated' : 'reset'} by ${update.initiator}`
							globalToast$.next({ title: msg })
						}
						const prevOps = RbSyncState.Client.localOps(get().rbSession)
						const newSession = SLL.createNewSession(update.list)
						const newRbSession = RbSyncState.Client.initSession<SLL.Operation, SLL.EditSession>(newSession)
						set({
							rbSession: newRbSession,
							sessionSeqId: update.newSessionSeqId,
							itemLocks: new Map(),
						})
						UPClient.PresenceStore.getState().onSessionChanged(prevOps)
						break
					}

					case 'commit-rejected': {
						set({ committing: false })
						globalToast$.next({ variant: 'destructive', title: update.msg })
						break
					}

					case 'locks-modified': {
						set(state =>
							Im.produce(state, draft => {
								for (const [itemId, wsClientId] of update.mutations) {
									if (wsClientId === null) draft.itemLocks.delete(itemId)
									else draft.itemLocks.set(itemId, wsClientId)
								}
							})
						)
						break
					}

					case 'commit':
					case 'reset':
						set({ committing: false })
						break

					case 'commit-started': {
						set({ committing: true })
						break
					}

					default:
						assertNever(update)
				}
			},

			writeIncomingOperations(ops: SLL.Operation[]) {
				const newRbSession = RbSyncState.Client.processIncomingOps(get().rbSession, ops, sllReducer)
				set({ rbSession: newRbSession })
				for (const op of ops) {
					get().syncedOp$.next(op)
				}
			},

			// try to call this such that react will batch the rerenders
			async dispatch(newOp) {
				// import inline to avoid circular dep at module load time
				const UPClient = await import('@/systems/user-presence.client')

				const userId = UsersClient.loggedInUserId!
				const baseProps = { opId: createId(6), userId }

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

				set({ rbSession: RbSyncState.Client.processOutgoingOps(get().rbSession, [op], sllReducer) })

				let isComitting = false
				try {
					if (newOp.op === 'start-editing') {
						UPClient.PresenceStore.getState().updateActivity(UP.TOGGLE_EDITING_QUEUE_TRANSITIONS.createActivity)
					} else if (newOp.op === 'finish-editing') {
						if (get().editors.size === 0 && get().isModified) {
							set({ committing: true })
							isComitting = true
						}
						UPClient.PresenceStore.getState().updateActivity(UP.TOGGLE_EDITING_QUEUE_TRANSITIONS.removeActivity)
					}

					await processUpdate({
						code: 'op',
						op,
						sessionSeqId: get().sessionSeqId,
					})
				} finally {
					if (isComitting) {
						set({ committing: false })
					}
				}
			},

			async reset() {
				await processUpdate({
					code: 'reset',
					sessionSeqId: get().sessionSeqId,
				})
			},
		}
	})

	return store
}

async function processUpdate(update: SLL.ClientUpdate) {
	const res = await RPC.orpc.sharedLayerList.processUpdate.call(update)

	if (res && res.code === 'err:permission-denied') {
		RbacClient.handlePermissionDenied(res)
		return
	} else if (res) {
		globalToast$.next({ variant: 'destructive', title: res.msg })
	}
	return res
}

export function useIsItemLocked(itemId: LL.ItemId) {
	const globalVoteState = VotesClient.useVoteState()
	const config = UsersClient.useLoggedInUser()
	const locked = Zus.useStore(Store, (s) => {
		const lockedClientId = s.itemLocks.get(itemId)
		if (!lockedClientId) return false
		return config && config.wsClientId !== lockedClientId
	})
	const voteState = globalVoteState?.itemId === itemId ? globalVoteState : undefined
	return locked || voteState?.code === 'in-progress'
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
