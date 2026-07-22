import type * as FRM from '@/lib/frame'
import * as ItemMut from '@/lib/item-mutations'
import * as ODSM from '@/lib/odsm'
import * as RSel from '@/lib/reselect'
import { assertNever } from '@/lib/type-guards'
import * as ZusUtils from '@/lib/zustand'
import * as BB from '@/models/backburner.models'
import type * as F from '@/models/filter.models'
import * as LL from '@/models/layer-list.models'

import { toast } from '@/lib/toast'
import * as SLL from '@/models/shared-layer-list'
import type * as UP from '@/models/user-presence'
import * as RPC from '@/orpc.client'
import * as RbacClient from '@/systems/rbac.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'
import * as Rx from 'rxjs'
import type * as Zus from 'zustand'

export type Store = {
	queue: State
}
export type Key = FRM.InstanceKeyOfState<Store>
export type KeyProp = { queue: Key }

export type State = {
	serverId: string
	rbSession: ODSM.Client.Session<SLL.Operation, SLL.State>

	handleServerUpdate(update: SLL.Update): void
	writeIncomingOperations(ops: SLL.Operation[]): void

	syncedOp$: Rx.Subject<SLL.Operation>
	// user-attributed queue + layer-request ops that landed on the synced timeline, for transient
	// presence-panel event text (both surface on the queue tab's presence panel)
	presenceEvent$: Rx.Subject<UP.PresenceEvent>
	committing: boolean

	// -------- derived properties --------
	layerList: LL.List
	mutations: ItemMut.Mutations
	isModified: boolean
	backburner: BB.BackburnerItem[]
	savedBackburner: BB.BackburnerItem[]
	backburnerModified: boolean
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
		if (op.op === 'discard-abandoned-queue-edits' || op.op === 'discard-abandoned-request-edits') {
			const draft = op.op === 'discard-abandoned-queue-edits' ? 'queue' : 'layer request'
			toast.info(`Unsaved ${draft} edits were discarded: nobody was left editing them`)
			return
		}
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
			case 'backburner-add':
				presenceEvent$.next({ userId: op.userId, action: 'added-layer-request' })
				break
			case 'backburner-update':
				presenceEvent$.next({ userId: op.userId, action: 'edited-layer-request' })
				break
			case 'backburner-remove':
				presenceEvent$.next({ userId: op.userId, action: 'removed-layer-request' })
				break
			case 'backburner-reorder':
				presenceEvent$.next({ userId: op.userId, action: 'moved-layer-request' })
				break
			case 'backburner-combine':
				presenceEvent$.next({ userId: op.userId, action: 'combined-layer-requests' })
				break
			case 'backburner-save':
				presenceEvent$.next({ userId: op.userId, action: 'saved-layer-requests' })
				break
			case 'backburner-reset':
				presenceEvent$.next({ userId: op.userId, action: 'discarded-layer-request-edits' })
				break
		}
	}
	const initRbSession = ODSM.Client.initSession<SLL.Operation, SLL.State>(SLL.createNewState())

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
			backburner: initRbSession.localState.backburner,
			savedBackburner: initRbSession.localState.savedBackburner,
			backburnerModified: false,

			handleServerUpdate(update) {
				switch (update.code) {
					case 'init': {
						// processInit rebases in-flight pending ops onto the snapshot so the acks that follow still resolve
						const newRbSession = ODSM.Client.processInit(get().rbSession, update.state, update.ops, SLL.reducer)
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
						const res = ODSM.Client.processAcks(session, [update.opId], SLL.reducer)
						if (res.unknownOpIds.length > 0) console.warn(`received ack for unknown op ${update.opId}`)
						if (res.session !== session) {
							set({ rbSession: res.session })
							if (res.rejected) console.error('acked queue op diverged from the server:', res.error.data)
							else for (const se of res.sideEffects) onSideEffect(se)
							for (const ackedOp of res.ackedOps) get().syncedOp$.next(ackedOp)
						}
						break
					}
					case 'rejected': {
						// the server refused our op, so it will never be acked -- replay the local timeline without it
						console.debug(`queue op ${update.opId} rejected by the server: ${update.reason}`)
						set({ rbSession: ODSM.Client.dropPendingOps(get().rbSession, [update.opId], SLL.reducer) })
						break
					}
					default:
						assertNever(update)
				}
			},

			writeIncomingOperations(ops: SLL.Operation[]) {
				const res = ODSM.Client.processIncomingOps(get().rbSession, ops, SLL.reducer)
				set({ rbSession: res.session })
				if (res.rejected) console.error('incoming queue op diverged from the server:', res.error.data)
				else for (const se of res.sideEffects) onSideEffect(se)
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
			if (localState.backburner !== queue.backburner) updates.backburner = localState.backburner
			if (localState.savedBackburner !== queue.savedBackburner) updates.savedBackburner = localState.savedBackburner
			const backburnerModified = SLL.hasBackburnerMutations(localState)
			if (backburnerModified !== queue.backburnerModified) updates.backburnerModified = backburnerModified
			// the backburner has its own editing session; queue modified-ness covers only the queue draft
			const hasMutations = SLL.hasMutations(localState)
			if (hasMutations !== queue.isModified) updates.isModified = hasMutations
			if (Object.keys(updates).length > 0) set(updates)
		}),
	)

	args.sub.add(
		RPC.observe('layerQueue.watchOps', () => RPC.orpc.layerQueue.watchOps.call({ serverId })).pipe(RPC.dropServerNotLoaded()).subscribe(
			update => {
				get().handleServerUpdate(update)
			},
		),
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

	export const nextLayerId = RSel.createDeepSelector([layerList], (list) => LL.getNextLayerId(list))

	export type ItemEntry = {
		index: LL.ItemIndex
		item: LL.Item
		parentItem: LL.VoteItem | undefined
		isLocallyLast: boolean
		lastLocalIndex: LL.ItemIndex
	}

	// Single O(N) pass that resolves per-item structural data (position, parent, local-last-ness) for the
	// whole list at once. Per-item selectors below read from this map in O(1) instead of each re-scanning the
	// full list, so a layerList mutation costs O(N) total rather than O(N^2) across all mounted rows.
	// Ref-memoized only (no deep result check): layerList is copy-on-write, so its ref changes only on a real
	// mutation, and the per-item selectors provide their own deep result stability.
	const itemIndex = RSel.createSelector([layerList], (list): Map<LL.ItemId, ItemEntry> => {
		const map = new Map<LL.ItemId, ItemEntry>()
		const lastTopLevelIndex: LL.ItemIndex = { outerIndex: list.length - 1, innerIndex: null }
		for (let outerIndex = 0; outerIndex < list.length; outerIndex++) {
			const item = list[outerIndex]
			map.set(item.itemId, {
				index: { outerIndex, innerIndex: null },
				item,
				parentItem: undefined,
				isLocallyLast: outerIndex === list.length - 1,
				lastLocalIndex: lastTopLevelIndex,
			})
			if (LL.isVoteItem(item)) {
				const lastChoiceIndex = item.choices.length - 1
				const lastChoiceLocalIndex: LL.ItemIndex = { outerIndex, innerIndex: lastChoiceIndex }
				for (let innerIndex = 0; innerIndex < item.choices.length; innerIndex++) {
					const choice = item.choices[innerIndex]
					map.set(choice.itemId, {
						index: { outerIndex, innerIndex },
						item: choice,
						parentItem: item,
						isLocallyLast: innerIndex === lastChoiceIndex,
						lastLocalIndex: lastChoiceLocalIndex,
					})
				}
			}
		}
		return map
	})

	// Structural per-item read (position, parent, local-last-ness); undefined when the item is no longer in the
	// list. O(1) lookup into itemIndex, deep-checked for render stability. Consumers destructure what they need.
	// mutation state is kept out of here (see itemState) so structural-only consumers don't re-render on mutation
	// changes.
	export const itemEntry = RSel.memoizeFactory((itemId: string) =>
		RSel.createDeepSelector([itemIndex], (index): ItemEntry | undefined => index.get(itemId))
	)

	export const itemState = RSel.memoizeFactory((itemId: string) =>
		RSel.createDeepSelector([itemIndex, mutations], (index, mutations): ItemState => {
			const entry = index.get(itemId)
			if (!entry) throw new Error(`Item not found: ${itemId}`)
			return {
				index: entry.index,
				item: entry.item,
				mutationState: ItemMut.toItemMutationState(mutations, itemId, entry.parentItem?.layerId),
				isLocallyLast: entry.isLocallyLast,
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
	export function backburner(store: Store) {
		return store.queue.backburner
	}
	export function backburnerModified(store: Store) {
		return store.queue.backburnerModified
	}
	export function savedBackburner(store: Store) {
		return store.queue.savedBackburner
	}
	export const backburnerItem = RSel.memoizeFactory((itemId: string) =>
		RSel.createDeepSelector([backburner], (items): BB.BackburnerItem | undefined => items.find(item => item.itemId === itemId))
	)
	const backburnerMutations = RSel.createDeepSelector(
		[backburner, savedBackburner],
		(draft, saved): ItemMut.Mutations => BB.diffMutations(draft, saved),
	)
	export const backburnerItemMutation = RSel.memoizeFactory((itemId: string) =>
		RSel.createDeepSelector(
			[backburnerMutations],
			(mutations): ItemMut.ItemMutationState => ItemMut.toItemMutationState(mutations, itemId),
		)
	)
}

// these ops run as an editing session is being finished, so they must not claim a new one
const SESSION_CLOSING_OPS = new Set<SLL.OpCode>(['save', 'reset-to-saved', 'backburner-save', 'backburner-reset'])

export namespace Actions {
	// try to call this such that react will batch the rerenders
	export async function dispatch(stores: KeyProp, newOp: SLL.NewClientOperation) {
		const slice = ZusUtils.toPartialStore(stores.queue, 'queue')
		const userId = UsersClient.loggedInUserId!
		const localState = slice.getState().rbSession.localState
		// backburner ops belong to the backburner's own editing session, gated by its own window counter
		const isBackburnerOp = newOp.op.startsWith('backburner-')
		const editWindowSeqId = isBackburnerOp ? localState.backburnerEditWindowSeqId : localState.editWindowSeqId
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

		const prev = slice.getState().rbSession
		const outgoing = ODSM.Client.processOutgoingOps(prev, [op], SLL.reducer)
		if (outgoing.rejected) {
			// op is a no-op against local state (stale edit window, pending generation, invalid result);
			// drop it without sending
			console.debug('layer queue op rejected:', (outgoing.error.data as SLL.Rejection).code)
			return
		}
		slice.setState({ rbSession: outgoing.session })

		const serverId = slice.getState().serverId
		// a draft edit registers the user as an editor, so no one has to press "Start Editing" first
		if (!SESSION_CLOSING_OPS.has(op.op)) {
			if (isBackburnerOp) UPClient.Actions.ensureEditingLayerRequests(serverId)
			else UPClient.Actions.ensureEditingQueue(serverId)
		}

		let res: Awaited<ReturnType<typeof RPC.orpc.layerQueue.dispatchOp.call>>
		try {
			res = await RPC.orpc.layerQueue.dispatchOp.call({ serverId, op })
		} catch (error) {
			// the op will never be acked, so it must leave the pending set -- see dropPendingOps
			rollbackOp(slice, op.opId)
			console.error('layer queue op dispatch failed:', error)
			toast.error('Failed to apply queue operation')
			return
		}
		if (res.code === 'ok') return
		rollbackOp(slice, op.opId)
		if (res.code === 'err:permission-denied') RbacClient.handlePermissionDenied(res)
		else toast.error('msg' in res ? res.msg : res.code)
	}

	// a refused op stays applied to the local state until we replay the timeline without it. leaving it pending
	// also pins localState to the moment of refusal, so the queue would stop reflecting the server entirely.
	function rollbackOp(slice: Zus.StoreApi<State>, opId: string) {
		slice.setState({ rbSession: ODSM.Client.dropPendingOps(slice.getState().rbSession, [opId], SLL.reducer) })
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

	export function addBackburnerItem(stores: KeyProp, args: { filter: F.FilterNode }) {
		const item: BB.BackburnerItem = {
			itemId: BB.createItemId(),
			filter: args.filter,
			source: { discordId: UsersClient.loggedInUserId! },
			createdAt: Date.now(),
		}
		void dispatch(stores, { op: 'backburner-add', item })
	}

	export function updateBackburnerItem(stores: KeyProp, itemId: string, args: { filter: F.FilterNode }) {
		void dispatch(stores, { op: 'backburner-update', itemId, filter: args.filter })
	}

	export function removeBackburnerItems(stores: KeyProp, itemIds: string[]) {
		void dispatch(stores, { op: 'backburner-remove', itemIds })
	}

	export function reorderBackburnerItem(stores: KeyProp, itemId: string, newIndex: number) {
		void dispatch(stores, { op: 'backburner-reorder', itemId, newIndex })
	}

	export function saveBackburner(stores: KeyProp, opts?: { force?: boolean }) {
		void dispatch(stores, { op: 'backburner-save', force: opts?.force })
	}

	export function resetBackburner(stores: KeyProp) {
		void dispatch(stores, { op: 'backburner-reset' })
	}

	export function combineBackburnerItems(stores: KeyProp, targetItemId: string, sourceItemId: string) {
		const list = ZusUtils.getState(stores.queue).queue.backburner
		const target = list.find(item => item.itemId === targetItemId)
		const source = list.find(item => item.itemId === sourceItemId)
		if (target && source) {
			const merged = BB.mergeTemplateFilters(target.filter, source.filter)
			if (merged.code !== 'ok') {
				toast.error('Cannot combine these requests: a filter is applied normally on one and inverted on the other')
				return
			}
		}
		void dispatch(stores, { op: 'backburner-combine', targetItemId, sourceItemId })
	}
}
