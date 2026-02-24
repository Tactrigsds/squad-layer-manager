import { globalToast$ } from '@/hooks/use-global-toast'
import { createId } from '@/lib/id'
import * as Obj from '@/lib/object'
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

	// state plus any in-flight operations applied
	session: SLL.EditSession

	// state that we're sure is syncronized between server and client
	syncedState: SLL.EditSession

	// operation ids which have not been synced from this client
	outgoingOpsPendingSync: string[]

	// operations that have come from the server that represent potential conflicts
	incomingOpsPendingSync: SLL.Operation[]

	itemLocks: SLL.ItemLocks

	handleServerUpdate(update: SLL.Update): void
	dispatch(op: SLL.NewOperation): Promise<void>
	writeIncomingOperations(ops: SLL.Operation[]): void

	syncedOp$: Rx.Subject<SLL.Operation>
	committing: boolean

	reset(): Promise<void>

	// -------- derived properties --------
	layerList: LL.Item[]
	isModified: boolean
}

const [_useServerUpdate, serverUpdate$] = ReactRx.bind<SLL.Update>(
	RPC.observe(() => RPC.orpc.sharedLayerList.watchUpdates.call()),
)

export const Store = createStore()

function createStore() {
	const store = Zus.createStore<Store>((set, get, store) => {
		const session = SLL.createNewSession()

		store.subscribe((state, prev) => {
			if (state.session.list !== state.layerList) {
				set({ layerList: state.session.list })
			}

			const hasMutations = SLL.hasMutations(state.session)
			if (hasMutations !== SLL.hasMutations(prev.session)) {
				set({ isModified: hasMutations })
			}
		})

		return {
			session,

			sessionSeqId: 0,
			syncedState: SLL.createNewSession(),
			itemLocks: new Map(),

			outgoingOpsPendingSync: [],
			incomingOpsPendingSync: [],

			committing: false,
			syncedOp$: new Rx.Subject(),

			// shorthands
			layerList: session.list,
			isModified: false,

			async handleServerUpdate(update) {
				switch (update.code) {
					case 'init': {
						set({
							...store.getInitialState(),
							session: update.session,
							syncedState: update.session,
							outgoingOpsPendingSync: [],
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
						const newSession = SLL.createNewSession(update.list)
						set(state =>
							Im.produce(state, draft => {
								draft.sessionSeqId = update.newSessionSeqId
								draft.session = draft.syncedState = newSession
								draft.itemLocks = new Map()
							})
						)
						UPClient.PresenceStore.getState().onSessionChanged(newSession)
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
				for (const op of ops) {
					const state = get()
					const nextPendingOpId = state.outgoingOpsPendingSync[0]
					if (nextPendingOpId && nextPendingOpId === op.opId) {
						const serverDivergedOps = state.incomingOpsPendingSync
						const serverSession = Obj.deepClone(state.syncedState)
						const newOpsHead = [...serverDivergedOps, op]
						SLL.applyOperations(serverSession, newOpsHead)

						set({
							session: serverSession,
							syncedState: serverSession,
							incomingOpsPendingSync: [],
							outgoingOpsPendingSync: this.outgoingOpsPendingSync.slice(1),
						})
						for (const op of newOpsHead) {
							state.syncedOp$.next(op)
						}
					} else if (nextPendingOpId) {
						set({ incomingOpsPendingSync: [...state.incomingOpsPendingSync, op] })
					} else {
						set(state =>
							Im.produce(state, draft => {
								SLL.applyOperations(draft.syncedState, [op])
								SLL.applyOperations(draft.session, [op])
							})
						)
						state.syncedOp$.next(op)
					}
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

				set(state =>
					Im.produce(state, draft => {
						draft.outgoingOpsPendingSync.push(op.opId)
						SLL.applyOperations(draft.session, [op])
					})
				)

				let isComitting = false
				try {
					if (newOp.op === 'start-editing') {
						UPClient.PresenceStore.getState().updateActivity(UP.TOGGLE_EDITING_TRANSITIONS.createActivity)
					} else if (newOp.op === 'finish-editing') {
						if (get().session.editors.size === 0 && SLL.hasMutations(get().session)) {
							set({ committing: true })
							isComitting = true
						}
						UPClient.PresenceStore.getState().updateActivity(UP.TOGGLE_EDITING_TRANSITIONS.removeActivity)
					}

					await processUpdate({
						code: 'op',
						op,
						expectedIndex: get().session!.ops.length - 1,
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
