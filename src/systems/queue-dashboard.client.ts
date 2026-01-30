// this file no longer has a decent organizing principle, we should be annexing it over time
import { distinctDeepEquals } from '@/lib/async'
import { sleep } from '@/lib/async'
import * as Gen from '@/lib/generator'
import * as ItemMut from '@/lib/item-mutations'
import * as Obj from '@/lib/object'
import * as CB from '@/models/constraint-builders'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as SS from '@/models/server-state.models'
import type * as SLL from '@/models/shared-layer-list'
import * as RPC from '@/orpc.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as ServerSettingsClient from '@/systems/server-settings.client'
import * as SLLClient from '@/systems/shared-layer-list.client'
import * as ReactRx from '@react-rxjs/core'
import { useMutation } from '@tanstack/react-query'
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
	addVoteItems: (items: LL.NewItem[]) => void
}

export function getSource(): LL.Source {
	return { type: 'manual', userId: UsersClient.loggedInUserId! }
}
export function getLLItemActions(llStore: LLStore, itemId: string): LLItemActions {
	const actions: LLItemActions = {
		dispatch(newItemOp) {
			const newOp: SLL.NewOperation = { ...newItemOp, itemId }
			void llStore.dispatch(newOp)
		},

		addVoteItems(choices) {
			const itemState = selectLLItemState(llStore, itemId)
			if (!LL.isVoteItem(itemState.item)) return
			const index: LL.ItemIndex = { innerIndex: itemState.item.choices.length, outerIndex: itemState.index.outerIndex }
			void llStore.dispatch({ op: 'add', index, items: choices })
		},
	}
	return actions
}

export function selectLLItemState(llStore: LLStore, itemId: string): LLItemState {
	const layerList = llStore.layerList

	const res = LL.findItemById(layerList, itemId)
	if (!res) throw new Error(`Item not found: ${itemId}`)
	const parentItem = LL.findParentItem(layerList, itemId)
	const { index, item } = res
	const isLocallyLast = LL.isLocallyLastIndex(itemId, layerList)

	return {
		index,
		item,
		mutationState: ItemMut.toItemMutationState(llStore.session.mutations, itemId, parentItem?.layerId),
		isLocallyLast,
	}
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

export const ExtraFiltersStore = Zus.createStore<LQY.ExtraQueryFiltersStore>((set, get, store) => {
	const extraFilters = new Set(localStorage.getItem('extraQueryFilters:v2')?.split(',') ?? [])
	void (async () => {
		await sleep(0)
		const filterEntities = await Rx.firstValueFrom(FilterEntityClient.initializedFilterEntities$())
		set(state => ({
			...state,
			extraFilters: new Set(Gen.filter(state.extraFilters.values(), f => filterEntities.has(f))),
		}))
	})()

	store.subscribe((state, prev) => {
		const extraFilters = Array.from(state.extraFilters)
		const prevExtraFilters = Array.from(prev.extraFilters)
		if (!Obj.deepEqual(extraFilters, prevExtraFilters)) {
			localStorage.setItem('extraQueryFilters:v2', extraFilters.join(','))
		}
	})

	return {
		extraFilters,
		select(update) {
			let filterIds = typeof update === 'function' ? update(Array.from(get().extraFilters)) : update
			const filterConfig = ServerSettingsClient.Store.getState().saved.queue.mainPool.filters
			filterIds = filterIds.filter(id => !filterConfig.some(filterConfig => filterConfig.filterId === id))
			set({
				extraFilters: new Set(filterIds),
			})
		},
		remove(filterId) {
			set(state => ({
				extraFilters: new Set(Gen.filter(state.extraFilters, id => id !== filterId)),
			}))
		},
	}
})

export function selectQueueStatusConstraints(
	settings: SS.PublicServerSettings,
): LQY.Constraint[] {
	const queryConstraints = SS.getSettingsConstraints(settings)
	return queryConstraints
}

export const LQStore = SLLClient.Store

export function useToggleSquadServerUpdates() {
	const saveChangesMutation = useMutation({
		mutationFn: (input: { disabled: boolean }) => RPC.orpc.layerQueue.toggleUpdatesToSquadServer.call(input),
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

export function getToggledRepeatRuleConstraints(settings: SS.PublicServerSettings, applyAs: SS.ConstraintApplyAs) {
	const dnrConstraints: LQY.Constraint[] = []
	const repeatRules = settings.queue.mainPool.repeatRules
	for (let i = 0; i < repeatRules.length; i++) {
		const rule = repeatRules[i]
		dnrConstraints.push(CB.repeatRule(`pool-checkboxes:dnr:${i}`, rule, {
			filterResults: applyAs !== 'disabled',
			invert: applyAs === 'inverted',
		}))
	}
	return dnrConstraints
}
