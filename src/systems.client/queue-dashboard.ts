import { lqServerStateUpdate$ } from '@/api/layer-queue.client'
import { globalToast$ } from '@/hooks/use-global-toast'
import { acquireInBlock, distinctDeepEquals } from '@/lib/async'
import * as FB from '@/lib/filter-builders'
import { createId } from '@/lib/id'
import { ItemMutations, ItemMutationState, WithMutationId } from '@/lib/item-mutations'
import * as ItemMut from '@/lib/item-mutations'
import { deepClone, selectProps } from '@/lib/object'
import { Getter, Setter } from '@/lib/zustand'
import * as ZusUtils from '@/lib/zustand'
import * as M from '@/models'
import * as RBAC from '@/rbac.models'
import { trpc } from '@/trpc.client'
import { Mutex } from 'async-mutex'
import { derive } from 'derive-zustand'
import * as Im from 'immer'
import * as Jotai from 'jotai'
import React from 'react'
import * as ReactRouterDOM from 'react-router-dom'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { configAtom } from './config.client'
import { fetchLoggedInUser } from './logged-in-user'
import { userPresenceState$, userPresenceUpdate$ } from './presence'

// -------- types --------
export type EditedHistoryFilterWithId = M.HistoryFilterEdited & WithMutationId
export type MutServerStateWithIds = M.UserModifiableServerState & {
	layerQueue: M.LayerListItem[]
	historyFilters: EditedHistoryFilterWithId[]
}

export type LLState = {
	layerList: M.LayerListItem[]
	listMutations: ItemMutations
	isVoteChoice?: boolean
}

export type LLStore = LLState & LLActions

export type LLActions = {
	move: (sourceIndex: number, targetIndex: number, modifiedBy: bigint) => void
	add: (items: M.NewLayerListItem[], index?: number) => void
	setItem: (id: string, update: React.SetStateAction<M.LayerListItem>) => void
	remove: (id: string) => void
	clear: () => void
}

export type LLItemState = { item: M.LayerListItem; mutationState: ItemMutationState }
export type LLItemStore = LLItemState & LLItemActions

export type LLItemActions = {
	setItem: React.Dispatch<React.SetStateAction<M.LayerListItem>>
	// if not present then removing is disabled
	remove?: () => void
}

// Queue Dashboard state
export type QDState = {
	editedServerState: MutServerStateWithIds
	queueMutations: ItemMutations
	serverState: M.LQServerState | null
	isEditing: boolean
	stopEditingInProgress: boolean
	canEditQueue: boolean
	canEditSettings: boolean
	poolApplyAs: {
		dnr: M.LayerQueryConstraint['applyAs']
		filter: M.LayerQueryConstraint['applyAs']
	}
	extraQueryFilters: { filterId: M.FilterEntityId; active: boolean }[]
}

export type QDStore = QDState & {
	applyServerUpdate: (update: M.LQServerStateUpdate) => void
	reset: () => void
	setSetting: (updater: (settings: Im.Draft<M.ServerSettings>) => void) => void
	setQueue: Setter<LLState>
	tryStartEditing: () => void
	tryEndEditing: () => void

	setPoolApplyAs: (type: keyof QDStore['poolApplyAs'], value: M.LayerQueryConstraint['applyAs']) => void

	extraQueryFilterActions: {
		upsert: (filterId: M.FilterEntityId, active: boolean) => void
		remove: (filterId: M.FilterEntityId) => void
	}
}

// -------- store initialization --------
export const createLLActions = (set: Setter<LLState>, get: Getter<LLState>): LLActions => {
	const remove = (id: string) => {
		set((state) =>
			Im.produce(state, (state) => {
				const layerList = state.layerList
				const index = layerList.findIndex((item) => item.itemId === id)
				if (index === -1) return
				layerList.splice(index, 1)
				ItemMut.tryApplyMutation('removed', id, state.listMutations)
			})
		)
	}
	return {
		setItem: (id, update) => {
			set((state) =>
				Im.produce(state, (draft) => {
					const index = draft.layerList.findIndex((item) => item.itemId === id)
					if (index === -1) return
					draft.layerList[index] = typeof update === 'function' ? update(draft.layerList[index]) : update
					draft.layerList[index].itemId = id
					ItemMut.tryApplyMutation('edited', id, draft.listMutations)
				})
			)
		},
		add: (newItems, index) => {
			set(
				Im.produce((state) => {
					const layerList = state.layerList
					const items = newItems.map(M.createLayerListItem)
					if (index === undefined) {
						layerList.push(...items)
					} else {
						layerList.splice(index, 0, ...items)
					}
					for (const item of items) {
						ItemMut.tryApplyMutation('added', item.itemId, state.listMutations)
					}
				}),
			)
		},
		move: (sourceIndex, targetIndex, modifiedBy) => {
			if (sourceIndex === targetIndex || sourceIndex === targetIndex + 1) return
			set((state) =>
				Im.produce(state, (draft) => {
					const layerList = draft.layerList
					const item = layerList[sourceIndex]
					item.source = {
						type: 'manual',
						userId: modifiedBy,
					}
					if (sourceIndex > targetIndex) {
						targetIndex++
					}
					layerList.splice(sourceIndex, 1)
					layerList.splice(targetIndex, 0, item)
					ItemMut.tryApplyMutation('moved', item.itemId, draft.listMutations)
				})
			)
		},
		remove,
		clear: () => {
			for (const item of get().layerList) {
				remove(item.itemId)
			}
		},
	}
}

const getVoteChoiceStore = (item: M.LayerListItem) => {
	const initialState: LLState = {
		listMutations: ItemMut.initMutations(),
		layerList: item.vote?.choices.map(choice => M.createLayerListItem({ layerId: choice, source: item.source })) ?? [],
		isVoteChoice: true,
	}

	return Zus.createStore<LLStore>((set, get) => ({
		...createLLActions(set, get),
		...initialState,
	}))
}

export const useVoteChoiceStore = (itemStore: Zus.StoreApi<LLItemStore>) => {
	const [store, _setStore] = React.useState<Zus.StoreApi<LLStore>>(getVoteChoiceStore(itemStore.getState().item))
	React.useEffect(() => {
		const unsubscribe = store.subscribe((state) => {
			const choices = state.layerList.map(item => item.layerId!)
			const defaultChoice = choices.length > 0 ? choices[0] : M.DEFAULT_LAYER_ID
			itemStore.setState({ item: { ...itemStore.getState().item, vote: { choices, defaultChoice } } })
		})
		return unsubscribe
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [itemStore])

	return store
}

export const selectLLState = (state: QDState): LLState => ({
	layerList: state.editedServerState.layerQueue,
	listMutations: state.queueMutations,
})

export const deriveLLStore = (store: Zus.StoreApi<QDStore>) => {
	const setLL = store.getState().setQueue
	const getLL = () => selectLLState(store.getState())
	const actions = createLLActions(setLL, getLL)

	return derive<LLStore>((get) => {
		return {
			...selectLLState(get(store)),
			...actions,
		}
	})
}

export const createLLItemStore = (
	set: Setter<LLItemState>,
	get: Getter<LLItemState>,
	initialState: LLItemState,
	removeItem?: () => void,
): LLItemStore => {
	return {
		...initialState,
		setItem: (update) => {
			if (typeof update === 'function') {
				set({ item: update(get().item) })
			} else {
				set({ item: update })
			}
		},
		remove: removeItem,
	}
}

export const deriveLLItemStore = (store: Zus.StoreApi<LLStore>, itemId: string) => {
	const actions: LLItemActions = {
		setItem: (update) => store.getState().setItem(itemId, update),
		remove: () => store.getState().remove(itemId),
	}

	return derive<LLItemStore>((get) => ({
		...actions,
		item: get(store).layerList.find((item) => item.itemId === itemId)!,
		mutationState: ItemMut.toItemMutationState(get(store).listMutations, itemId),
	}))
}

export const deriveVoteChoiceListStore = (itemStore: Zus.StoreApi<LLItemStore>) => {
	const mutationStore = Zus.createStore<ItemMutations>(() => ItemMut.initMutations())
	function selectLLState(state: LLItemState, mutState: ItemMutations): LLState {
		return {
			listMutations: mutState,
			layerList: state.item.vote?.choices.map((layerId) => ({ layerId, itemId: layerId, source: { type: 'gameserver' } })) ?? [],
			isVoteChoice: true,
		}
	}
	const llGet: Getter<LLState> = () => selectLLState(itemStore.getState(), mutationStore.getState())
	const llSet: Setter<LLState> = (update) => {
		const llState = llGet()
		const updated = typeof update === 'function' ? update(llState) : update
		if (updated.layerList) {
			const choices = updated.layerList!.map((item) => item.layerId!)
			const defaultChoice = choices[0] ?? itemStore.getState().item.vote?.defaultChoice
			itemStore.getState().setItem((prev) =>
				Im.produce(prev, (draft) => {
					if (!draft.vote) return
					draft.vote.choices = choices
					draft.vote.defaultChoice = defaultChoice
				})
			)
		}
		if (updated.listMutations) {
			mutationStore.setState(updated.listMutations)
		}
	}

	const actions = createLLActions(llSet, llGet)

	return derive<LLStore>((get) => {
		return {
			...selectLLState(get(itemStore), get(mutationStore)),
			...actions,
		}
	})
}

export function getEditableServerState(state: M.LQServerState): MutServerStateWithIds {
	const layerQueue = state.layerQueue
	const historyFilters = state.historyFilters.map((filter) => ({ ...filter, id: createId(6) }) as M.HistoryFilterEdited & WithMutationId)
	return {
		// @ts-expect-error idk
		historyFilters,
		layerQueue,
		layerQueueSeqId: state.layerQueueSeqId,
		settings: state.settings,
	}
}

export const initialState: QDState = {
	editedServerState: { historyFilters: [], layerQueue: [], layerQueueSeqId: 0, settings: M.ServerSettingsSchema.parse({ queue: {} }) },
	queueMutations: ItemMut.initMutations(),
	serverState: null,
	isEditing: false,
	canEditQueue: false,
	canEditSettings: false,
	stopEditingInProgress: false,
	extraQueryFilters: [],
	poolApplyAs: {
		dnr: 'field',
		filter: 'where-condition',
	},
}

export const QDStore = Zus.createStore<QDStore>((set, get) => {
	const canEdit$ = userPresenceState$.pipe(
		Rx.mergeMap(async (state) => {
			const user = await fetchLoggedInUser()
			const canEdit = !state?.editState || state.editState.wsClientId === user?.wsClientId
			if (!user) return { canEditQueue: false, canEditSettings: false }
			return {
				canEditQueue: canEdit && RBAC.rbacUserHasPerms(user, { check: 'all', permits: [RBAC.perm('queue:write')] }),
				canEditSettings: canEdit && RBAC.rbacUserHasPerms(user, { check: 'all', permits: [RBAC.perm('settings:write')] }),
			}
		}),
		distinctDeepEquals(),
	)
	canEdit$.pipe(Rx.observeOn(Rx.asyncScheduler)).subscribe((canEdit) => {
		set(canEdit)
	})

	lqServerStateUpdate$.pipe(Rx.observeOn(Rx.asyncScheduler)).subscribe((update) => {
		if (!update) return
		get().applyServerUpdate(update)
	})

	userPresenceUpdate$.pipe(Rx.observeOn(Rx.asyncScheduler)).subscribe(async (update) => {
		const presence = update.state
		if (!presence?.editState) {
			if (get().isEditing && update.event === 'edit-kick') {
				globalToast$.next({ variant: 'edited', title: 'You have been kicked from your editing session' })
			}
			get().reset()
			return
		}
		const loggedInUser = await fetchLoggedInUser()
		if (presence.editState.wsClientId !== loggedInUser?.wsClientId) {
			if (get().isEditing && update.event === 'edit-kick') {
				globalToast$.next({ title: 'You have been kicked from your editing session' })
			}
			get().reset()
		}
	})

	const editChangeMtx = new Mutex()
	async function tryStartEditing() {
		using _ = await acquireInBlock(editChangeMtx)
		if (get().isEditing) return
		set({ isEditing: true })
		const res = await trpc.layerQueue.startEditing.mutate()
		switch (res.code) {
			case 'err:already-editing': {
				globalToast$.next({ title: 'Another user is already editing the queue' })
				set({ isEditing: false })
				get().reset()
				return
			}
			case 'ok': {
				break
			}
		}
	}

	async function tryEndEditing() {
		using _ = await acquireInBlock(editChangeMtx)
		if (!get().isEditing) return
		set({ stopEditingInProgress: true })
		set({ isEditing: false })
		void trpc.layerQueue.endEditing.mutate()
		try {
			const loggedInUser = await fetchLoggedInUser()
			await Rx.firstValueFrom(
				userPresenceState$.pipe(
					Rx.filter((a) => a?.editState === null || a?.editState?.wsClientId !== loggedInUser?.wsClientId),
					Rx.take(1),
				),
			)
		} finally {
			set({ stopEditingInProgress: false })
		}
	}

	const getInitialStateToReset = (): Partial<QDState> => {
		return {
			editedServerState: deepClone(initialState.editedServerState),
			queueMutations: ItemMut.initMutations(),
		}
	}

	return {
		...initialState,
		applyServerUpdate: (update) => {
			set({ serverState: update.state })
			get().reset()
		},
		reset: async () => {
			const serverStateUpdate = lqServerStateUpdate$.getValue()
			await tryEndEditing()
			if (!serverStateUpdate) {
				set({ ...getInitialStateToReset(), canEditQueue: get().canEditQueue, isEditing: get().isEditing })
				return
			}

			set({
				...getInitialStateToReset(),
				editedServerState: getEditableServerState(serverStateUpdate.state) ?? initialState.editedServerState,
			})
		},
		setSetting: (handler) => {
			set((state) =>
				Im.produce(state, (draft) => {
					handler(draft.editedServerState.settings)
				})
			)
			void tryStartEditing()
		},
		setPoolApplyAs(key, value) {
			set(state =>
				Im.produce(state, draft => {
					draft.poolApplyAs[key] = value
				})
			)
		},
		setQueue: (handler) => {
			const updated = typeof handler === 'function' ? handler(selectLLState(get())) : handler
			const maxQueueSize = Jotai.getDefaultStore().get(configAtom)?.maxQueueSize ?? 10
			if (updated.layerList && updated.layerList.length > maxQueueSize) {
				globalToast$.next({ title: `Too many queue items! Queue size limit is ${maxQueueSize}`, variant: 'destructive' })
				return
			}
			set({
				editedServerState: {
					...get().editedServerState,
					layerQueue: updated.layerList!,
				},
				queueMutations: updated.listMutations,
			})
			void tryStartEditing()
		},
		tryStartEditing,
		tryEndEditing,
		extraQueryFilterActions: {
			upsert(filterId, active) {
				set(state =>
					Im.produce(state, draft => {
						const existing = draft.extraQueryFilters.find(f => f.filterId === filterId)
						if (existing) {
							existing.active = active
						} else {
							draft.extraQueryFilters.push({ filterId, active })
						}
					})
				)
			},
			remove(filterId) {
				set(state =>
					Im.produce(state, draft => {
						const existingIdx = draft.extraQueryFilters.findIndex(f => f.filterId === filterId)
						if (existingIdx === -1) return
						draft.extraQueryFilters.splice(existingIdx, 1)
					})
				)
			},
		},
	}
})
// @ts-expect-error expose for debugging
window.QDStore = QDStore

export function selectQDQueryConstraints(state: QDStore): M.LayerQueryConstraint[] {
	const queryConstraints = M.getPoolConstraints(
		state.editedServerState.settings.queue.mainPool,
		state.poolApplyAs.dnr,
		state.poolApplyAs.filter,
	)

	for (const { filterId, active } of state.extraQueryFilters) {
		if (!active) continue
		queryConstraints.push({
			type: 'filter-entity',
			id: 'extra-filter:' + filterId,
			filterEntityId: filterId,
			applyAs: 'where-condition',
		})
	}

	return queryConstraints
}

export function useDerivedQueryContextForLQIndex(index: number, baseContext: M.LayerQueryContext, llStore: Zus.StoreApi<LLStore>) {
	const { isVoteChoice, layerList } = ZusUtils.useStoreDeep(llStore, (s) => selectProps(s, ['isVoteChoice', 'layerList']))
	const queueLayerIds = M.getAllLayerIdsFromList(layerList, { excludeVoteChoices: true })

	let constraints = baseContext.constraints ?? []
	const previousLayerIds = queueLayerIds.slice(0, index)

	// in the case of vote choices we want to enforce that there are no identical choices available
	if (isVoteChoice) {
		const filter = FB.comp(FB.inValues('id', Array.from(queueLayerIds)), { neg: true })
		constraints = [...constraints, M.filterToConstraint(filter, 'vote-choice-sibling-exclusion' + index)]
		// we don't want to apply the do-not-repeat rules across vote choice siblings
	}

	return {
		...baseContext,
		constraints,
		previousLayerIds: [...(baseContext.previousLayerIds ?? []), ...previousLayerIds],
	}
}

/**
 * Resets the editing state when navigating to a different page
 */
export function useResetEditOnNavigate() {
	const pathname = ReactRouterDOM.useLocation().pathname
	React.useEffect(() => {
		QDStore.getState().reset()
	}, [pathname])
}

export const LQStore = deriveLLStore(QDStore)
// @ts-expect-error expose for debugging
window.LQStore = LQStore

export function selectIsEditing(state: QDStore) {
	return state.isEditing
}

export function toDraggableItemId(id: string | null) {
	return JSON.stringify(id)
}
