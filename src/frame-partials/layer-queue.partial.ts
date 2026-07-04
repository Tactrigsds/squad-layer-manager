import { globalToast$ } from '@/hooks/use-global-toast'
import type * as FRM from '@/lib/frame'
import * as ItemMut from '@/lib/item-mutations'
import * as RSel from '@/lib/reselect'
import * as RbSyncState from '@/lib/rollback-synced-state'
import { assertNever } from '@/lib/type-guards'
import * as ZusUtils from '@/lib/zustand'
import * as LL from '@/models/layer-list.models'

import * as SLL from '@/models/shared-layer-list'
import type * as UP from '@/models/user-presence'
import * as RPC from '@/orpc.client'
import * as RbacClient from '@/systems/rbac.client'
import * as UsersClient from '@/systems/users.client'
import * as Rx from 'rxjs'

export type Store = {
	queue: State
}
export type Key = FRM.InstanceKeyOfState<Store>
export type KeyProp = { queue: Key }

export type State = {
	serverId: string
	rbSession: RbSyncState.Client.Session<SLL.Operation, SLL.State, SLL.SideEffect>

	handleServerUpdate(update: SLL.Update): void
	writeIncomingOperations(ops: SLL.Operation[]): void

	syncedOp$: Rx.Subject<SLL.Operation>
	// user-attributed queue ops that landed on the synced timeline, for transient presence-panel event text
	presenceEvent$: Rx.Subject<UP.PresenceEvent>
	committing: boolean

	// -------- derived properties --------
	layerList: LL.List
	mutations: ItemMut.Mutations
	isModified: boolean
}

export type Args = FRM.SetupArgs<{ serverId: string }, Store, Store>

export function initLayerQueue(args: Args) {
	const set = ZusUtils.toPartialSetter(args.set, 'queue')
	const get = ZusUtils.toPartialGetter(args.get, 'queue')
	const serverId = args.input.serverId
	const presenceEvent$ = new Rx.Subject<UP.PresenceEvent>()
	// side effects only fire when ops land on the synced timeline (incoming ops + acks of our own),
	// so each op produces at most one presence event per client
	const onSideEffect = (se: SLL.SideEffect) => {
		if (se.code !== 'op-outcome' || !se.success) return
		const op = se.op
		if (!('userId' in op)) return
		switch (op.op) {
			case 'add':
				presenceEvent$.next({ userId: op.userId, action: 'added-layers' })
				break
			case 'swap-factions':
				presenceEvent$.next({ userId: op.userId, action: 'swapped-factions' })
				break
			case 'delete':
				presenceEvent$.next({ userId: op.userId, action: 'deleted-item' })
				break
			case 'clone':
				presenceEvent$.next({ userId: op.userId, action: 'cloned-item' })
				break
			case 'move':
				presenceEvent$.next({ userId: op.userId, action: 'moved-item' })
				break
			case 'save':
				presenceEvent$.next({ userId: op.userId, action: 'saved-queue' })
				break
			case 'reset-to-saved':
				presenceEvent$.next({ userId: op.userId, action: 'discarded-queue-edits' })
				break
		}
	}
	const initRbSession = RbSyncState.Client.initSession<SLL.Operation, SLL.State, SLL.SideEffect>(SLL.createNewState(), {
		onSideEffect,
	})

	set(
		{
			serverId,
			rbSession: initRbSession,

			syncedOp$: new Rx.Subject(),
			presenceEvent$,

			// derived
			layerList: initRbSession.localState.list,
			mutations: initRbSession.localState.mutations,
			committing: false,
			isModified: false,

			handleServerUpdate(update) {
				switch (update.code) {
					case 'init': {
						// processInit rebases in-flight pending ops onto the snapshot so the acks that follow still resolve
						const newRbSession = RbSyncState.Client.processInit(get().rbSession, update.state, update.ops, SLL.reducer)
						set({ rbSession: newRbSession })
						break
					}
					case 'op': {
						get().writeIncomingOperations([update.op])
						break
					}
					case 'ack': {
						// ops are deterministic, so the server only sends back the id -- replay our pending copy
						const session = get().rbSession
						const res = RbSyncState.Client.processAcks(session, [update.opId], SLL.reducer)
						if (res.unknownOpIds.length > 0) console.warn(`received ack for unknown op ${update.opId}`)
						if (res.session !== session) {
							set({ rbSession: res.session })
							for (const ackedOp of res.ackedOps) get().syncedOp$.next(ackedOp)
						}
						break
					}
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
		} satisfies State,
	)

	args.sub.add(
		args.update$.subscribe(([state, prev]) => {
			const queue = state.queue
			const localState = queue.rbSession.localState
			const prevLocalState = prev.queue.rbSession.localState
			if (localState === prevLocalState) return

			const updates: Partial<State> = {}
			if (localState.saving !== queue.committing) updates.committing = localState.saving
			if (localState.list !== queue.layerList) updates.layerList = localState.list
			if (localState.mutations !== queue.mutations) updates.mutations = localState.mutations
			const hasMutations = SLL.hasMutations(localState)
			if (hasMutations !== queue.isModified) updates.isModified = hasMutations
			if (Object.keys(updates).length > 0) set(updates)
		}),
	)

	args.sub.add(
		RPC.observe(() => RPC.orpc.layerQueue.watchOps.call({ serverId })).subscribe(update => {
			get().handleServerUpdate(update)
		}),
	)
}

export type ItemState = {
	index: LL.ItemIndex
	item: LL.Item
	mutationState: ItemMut.ItemMutationState
	isLocallyLast: boolean
}

export namespace Sel {
	export function layerList(store: Store) {
		return store.queue.layerList
	}

	export const queueItemIds = RSel.createDeepSelector([layerList], (list) => list.map((item) => item.itemId))

	// undefined when the item is no longer in the list
	export const findItem = RSel.memoizeFactory((itemId: string) =>
		RSel.createDeepSelector([layerList], (list) => LL.findItemById(list, itemId))
	)

	export const parentItem = RSel.memoizeFactory((itemId: string) =>
		RSel.createDeepSelector([layerList], (list) => LL.findParentItem(list, itemId))
	)

	export const lastLocalIndex = RSel.memoizeFactory((itemId: string) =>
		RSel.createDeepSelector([layerList], (list) => LL.getLastLocalIndexForItem(itemId, list))
	)

	export const itemState = RSel.memoizeFactory((itemId: string) =>
		RSel.createDeepSelector([layerList, mutations], (layerList, mutations): ItemState => {
			const res = LL.findItemById(layerList, itemId)
			if (!res) throw new Error(`Item not found: ${itemId}`)
			const parentItem = LL.findParentItem(layerList, itemId)
			const { index, item } = res
			const isLocallyLast = LL.isLocallyLastIndex(itemId, layerList)

			return {
				index,
				item,
				mutationState: ItemMut.toItemMutationState(mutations, itemId, parentItem?.layerId),
				isLocallyLast,
			}
		})
	)
	export function mutations(store: Store) {
		return store.queue.mutations
	}
	export function isModified(store: Store) {
		return store.queue.isModified
	}
	export function committing(store: Store) {
		return store.queue.committing
	}
}

export namespace Actions {
	// try to call this such that react will batch the rerenders
	export async function dispatch(stores: KeyProp, newOp: SLL.NewClientOperation) {
		const slice = ZusUtils.toPartialStore(stores.queue, 'queue')
		const userId = UsersClient.loggedInUserId!
		const editWindowSeqId = slice.getState().rbSession.localState.editWindowSeqId
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

		slice.setState({ rbSession: RbSyncState.Client.processOutgoingOps(slice.getState().rbSession, [op], SLL.reducer) })

		const res = await RPC.orpc.layerQueue.dispatchOp.call({ serverId: slice.getState().serverId, op })
		if (res.code === 'err:permission-denied') {
			RbacClient.handlePermissionDenied(res)
			return
		} else if (res.code !== 'ok') {
			globalToast$.next({ variant: 'destructive', title: res.msg })
		}
	}

	export function dispatchItemOp(stores: KeyProp, itemId: string, newItemOp: SLL.NewContextItemOperation) {
		void dispatch(stores, { ...newItemOp, itemId })
	}

	export function addVoteItems(stores: KeyProp, itemId: string, choices: LL.NewItem[]) {
		const itemState = Sel.itemState(itemId)(ZusUtils.getState(stores.queue))
		if (!LL.isVoteItem(itemState.item)) return
		const index: LL.ItemIndex = { innerIndex: itemState.item.choices.length, outerIndex: itemState.index.outerIndex }
		void dispatch(stores, { op: 'add', index, items: choices })
	}
}
