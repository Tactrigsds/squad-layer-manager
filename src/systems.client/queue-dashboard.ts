import { distinctDeepEquals } from '@/lib/async'
import { createId } from '@/lib/id'
import * as ItemMut from '@/lib/item-mutations'
import * as Obj from '@/lib/object'
import * as ZusUtils from '@/lib/zustand'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as SS from '@/models/server-state.models'
import * as SLL from '@/models/shared-layer-list'
import * as MatchHistoryClient from '@/systems.client/match-history.client'
import * as SLLClient from '@/systems.client/shared-layer-list.client'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import { useMutation } from '@tanstack/react-query'
import React from 'react'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import * as ZusRx from 'zustand-rx'
import * as UsersClient from './users.client'

export type LLStore = SLLClient.Store

export type LLActions = {
	dispatch: (op: SLL.NewOperation) => void
}

export type LLItemState = {
	index: LL.ItemIndex
	item: LL.Item
	mutationState: ItemMut.ItemMutationState
	isLocallyLast: boolean
}

export type LLItemStore = LLItemState & LLItemActions

export type LLItemActions = {
	dispatch: (op: SLL.NewContextItemOperation) => void
	addVoteItems: (items: LL.NewLayerListItem[]) => void
}

export function getSource(): LL.Source {
	return { type: 'manual', userId: UsersClient.loggedInUserId! }
}

export function createLLItemStore(initialState: Omit<LLItemState, 'index' | 'isLocallyLast'>) {
	return Zus.createStore<LLItemStore>((set, get) => {
		const dispatch: LLItemActions['dispatch'] = (newItemOp) => {
			const item = Obj.deepClone(get().item)
			const op: SLL.Operation = { ...newItemOp, itemId: item.itemId, userId: UsersClient.loggedInUserId!, opId: createId(6) }
			SLL.applyOperation([item], op)
		}
		const actions: LLItemActions = {
			dispatch,
			addVoteItems(items) {
				const item = Obj.deepClone(get().item)
				if (!LL.isParentVoteItem(item)) return

				// pretending that this is the outer list
				const op: SLL.NewOperation = {
					op: 'add',
					index: { outerIndex: item.choices.length, innerIndex: null },
					items,
				}
				SLL.applyOperation(item.choices, op)
				set({ item })
			},
		}

		return {
			...initialState,
			...actions,
			index: { outerIndex: 0, innerIndex: null },
			isLocallyLast: true,
		}
	})
}

// export function useNewLLItemStore(initialState: LLItemState) {
// 	initialState = ReactHelpers.useDeepEqualsMemo(() => initialState, [initialState])
// 	ReactHelpers.useRefConstructor(() => {
// 	})
// }

export function useDerivedLLItemStore(llStore: Zus.StoreApi<LLStore>, itemId: LL.ItemId) {
	const [store, subHandle] = React.useMemo(() => deriveLLItemStore(llStore, itemId), [llStore, itemId])
	ZusUtils.useSubHandle(subHandle)
	return store
}

export function deriveLLItemStore(llStore: Zus.StoreApi<SLLClient.Store>, itemId: string) {
	let subHandle!: ZusUtils.SubHandle
	const store = Zus.createStore<LLItemStore>((set, get) => {
		function deriveState(llState: LLStore): LLItemState | null {
			const layerList = llState.layerList

			const res = LL.findItemById(layerList, itemId)
			if (!res) return null
			const parentItem = LL.findParentItem(layerList, itemId)
			const { item, ...index } = res
			const isLocallyLast = LL.isLocallyLastIndex(itemId, layerList)

			return {
				index,
				item,
				mutationState: ItemMut.toItemMutationState(llState.session.mutations, itemId, parentItem?.layerId),
				isLocallyLast,
			}
		}

		const derived$ = new Rx.Observable<LLItemState | null>((observer) => {
			const unsub = llStore.subscribe((state) => {
				observer.next(deriveState(state))
			})
			return () => unsub()
		})

		subHandle = ZusUtils.createSubHandle(
			(subs) =>
				subs.push(derived$.subscribe((state) => {
					if (state) set(state)
				})),
		)

		const actions: LLItemActions = {
			dispatch(newItemOp) {
				const newOp: SLL.NewOperation = { ...newItemOp, itemId }
				llStore.getState().dispatch(newOp)
			},

			addVoteItems(choices) {
				const item = get().item
				if (!LL.isParentVoteItem(item)) return
				const index: LL.ItemIndex = { innerIndex: item.choices.length, outerIndex: get().index.outerIndex }
				llStore.getState().dispatch({ op: 'add', index, items: choices })
			},
		}

		return { ...deriveState(llStore.getState())!, ...actions }
	})
	return [store, subHandle] as const
}

export const [useLayerItemsState, layerItemsState$] = ReactRx.bind(
	Rx.combineLatest([
		ZusRx.toStream(SLLClient.Store).pipe(Rx.map(s => s.layerList), Rx.distinctUntilChanged()),
		MatchHistoryClient.recentMatches$,
	]).pipe(
		Rx.map(([layerList, history]) => {
			return LQY.resolveLayerItemsState(layerList, history)
		}),
		distinctDeepEquals(),
	),
)

export function setup() {
	layerItemsState$.subscribe()
}

export function getExtraFiltersConstraints(extraFiltersState: LQY.ExtraQueryFiltersState) {
	const constraints: LQY.LayerQueryConstraint[] = []
	for (const filterId of extraFiltersState.filters) {
		if (!extraFiltersState.activeFilters.has(filterId)) continue
		constraints.push({
			type: 'filter-entity',
			id: 'extra-filter:' + filterId,
			filterEntityId: filterId,
			applyAs: 'where-condition',
		})
	}
	return constraints
}

export function selectBaseQueryConstraints(
	settings: SS.PublicServerSettings,
	applyAs: LQY.ApplyAsState,
): LQY.LayerQueryConstraint[] {
	const queryConstraints = SS.getPoolConstraints(
		settings.queue.mainPool,
		applyAs.dnr,
		applyAs.filter,
	)

	return queryConstraints
}

export const LQStore = SLLClient.Store

export function useToggleSquadServerUpdates() {
	const saveChangesMutation = useMutation({
		mutationFn: (input: { disabled: boolean }) => trpc.layerQueue.toggleUpdatesToSquadServer.mutate(input),
	})

	return {
		disableUpdates: () => {
			saveChangesMutation.mutate({ disabled: true })
		},
		enableUpdates: () => {
			saveChangesMutation.mutate({ disabled: false })
		},
	}
}
