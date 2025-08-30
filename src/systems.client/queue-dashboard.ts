import { globalToast$ } from '@/hooks/use-global-toast'
import { useToast } from '@/hooks/use-toast'
import { acquireInBlock, distinctDeepEquals } from '@/lib/async'
import { ItemMutations, ItemMutationState } from '@/lib/item-mutations'
import * as ItemMut from '@/lib/item-mutations'
import * as Obj from '@/lib/object'
import { useRefConstructor } from '@/lib/react'
import { assertNever } from '@/lib/type-guards'
import { Getter, Setter } from '@/lib/zustand'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as SS from '@/models/server-state.models'
import * as RBAC from '@/rbac.models'
import * as ConfigClient from '@/systems.client/config.client'
import { lqServerStateUpdate$ } from '@/systems.client/layer-queue.client'
import * as MatchHistoryClient from '@/systems.client/match-history.client'
import * as RbacClient from '@/systems.client/rbac.client'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import { useMutation } from '@tanstack/react-query'
import { Mutex } from 'async-mutex'
import { derive } from 'derive-zustand'
import deepEqual from 'fast-deep-equal'
import * as Im from 'immer'
import React from 'react'
import * as ReactRouterDOM from 'react-router-dom'
import * as Rx from 'rxjs'
import superjson from 'superjson'
import * as Zus from 'zustand'
import * as ZusRx from 'zustand-rx'
import { subscribeWithSelector } from 'zustand/middleware'
import { fetchConfig } from './config.client'
import * as FilterEntityClient from './filter-entity.client'
import { userPresenceState$, userPresenceUpdate$ } from './presence'
import * as SquadServerClient from './squad-server.client'
import * as UsersClient from './users.client'

// -------- types --------
export type MutServerStateWithIds = SS.UserModifiableServerState & {
	layerQueue: LL.LayerListItem[]
}

/**
 * Layer List State
 */
export type LLState = {
	layerList: LL.LayerListItem[]

	// if this layer is set as the next one on the server but is only a partial, then we want to "backfill" the details that the server fills in for us. If this property is defined that indicates that we should attempt to backfill
	nextLayerBackfillId?: string
	listMutations: ItemMutations
}

export type LLStore = LLState & LLActions

export type LLActions = {
	move: (movedItemId: LL.LayerListItemId, targetCursor: LL.LLItemRelativeCursor, modifiedBy: bigint) => void
	add: (items: LL.NewLayerListItem[], index?: LL.LLItemIndex | LL.LLItemRelativeCursor) => void
	setItem: (id: string, update: React.SetStateAction<LL.LayerListItem>) => void
	remove: (id: string) => void
	clear: () => void
}

export type LLItemState = {
	index: number
	innerIndex: number | null
	item: LL.LayerListItem
	mutationState: ItemMutationState
	isVoteChoice: boolean
}

export type LLItemStore = LLItemState & LLItemActions

export type LLItemActions = {
	setItem: React.Dispatch<React.SetStateAction<LL.LayerListItem>>
	addVoteItems: (items: LL.NewLayerListItem[]) => void
	swapFactions: () => void
	// if not present then removing is disabled
	remove?: () => void
}

export type ExtraQueryFiltersActions = {
	setActive: (filterId: F.FilterEntityId, active: boolean) => void
	select: (newFilterId: F.FilterEntityId, oldFilterId: F.FilterEntityId) => void
	add: (newFilterId: F.FilterEntityId, active: boolean) => void
	remove: (filterId: F.FilterEntityId) => void
}

export type ExtraQueryFiltersState = {
	filters: Set<F.FilterEntityId>
	active: Set<F.FilterEntityId>
}

export type ExtraQueryFiltersStore = ExtraQueryFiltersActions & ExtraQueryFiltersState

export function useExtraFiltersStore(useIndependentActiveState: boolean = false) {
	const storeRef = useRefConstructor(() => {
		const activeStore = Zus.createStore(() => ({ active: new Set<F.FilterEntityId>() }))
		const addActive = (draft: Im.WritableDraft<QDStore>, filterId: F.FilterEntityId) => {
			if (useIndependentActiveState) {
				console.log('setting active', filterId)
				activeStore.setState(state => {
					const newState = new Set(state.active)
					newState.add(filterId)
					return { active: newState }
				})
			} else {
				draft.activeExtraQueryFilters.add(filterId)
			}
		}
		const removeActive = (draft: QDStore, filterId: F.FilterEntityId) => {
			if (useIndependentActiveState) {
				activeStore.setState(state => {
					const newState = new Set(state.active)
					newState.delete(filterId)
					return { active: newState }
				})
			} else {
				draft.activeExtraQueryFilters.delete(filterId)
			}
		}

		const actions: ExtraQueryFiltersActions = {
			setActive(filterId, active) {
				QDStore.setState((state) =>
					Im.produce(state, (draft) => {
						if (!active) {
							removeActive(draft, filterId)
							return
						}
						if (!draft.extraQueryFilters.has(filterId)) {
							draft.extraQueryFilters.add(filterId)
						}
						addActive(draft, filterId)
					})
				)
			},
			select(newFilterId, oldFilterId) {
				QDStore.setState(state =>
					Im.produce(state, draft => {
						removeActive(draft, oldFilterId)
						addActive(draft, newFilterId)
						draft.extraQueryFilters.add(newFilterId)
					})
				)
			},
			add(filterId) {
				QDStore.setState(state =>
					Im.produce(state, draft => {
						draft.extraQueryFilters.add(filterId)
						addActive(draft, filterId)
					})
				)
			},
			remove(filterId) {
				QDStore.setState(state =>
					Im.produce(state, draft => {
						draft.extraQueryFilters.delete(filterId)
						removeActive(draft, filterId)
					})
				)
			},
		}

		return derive<ExtraQueryFiltersStore>(get => ({
			filters: get(QDStore).extraQueryFilters,
			active: useIndependentActiveState ? get(activeStore).active : get(QDStore).activeExtraQueryFilters,
			...actions,
		}))
	})

	return storeRef.current
}

// Queue Dashboard state
export type QDState = {
	initialized: boolean
	editedServerState: MutServerStateWithIds

	// if this layer is set as the next one on the server but is only a partial, then we want to "backfill" the details that the server fills in for us.
	nextLayerBackfillId?: string
	queueMutations: ItemMutations
	serverState: SS.LQServerState | null
	isEditing: boolean
	stopEditingInProgress: boolean
	canEditQueue: boolean
	canEditSettings: boolean
	poolApplyAs: {
		dnr: LQY.LayerQueryConstraint['applyAs']
		filter: LQY.LayerQueryConstraint['applyAs']
	}
	extraQueryFilters: Set<F.FilterEntityId>
	activeExtraQueryFilters: Set<F.FilterEntityId>

	// M.toQueueLayerKey and stuff to lookup the id
	hoveredConstraintItemId?: string
}

export type QDStore = QDState & {
	applyServerUpdate: (update: SS.LQServerStateUpdate) => void
	reset: () => Promise<void>
	setSetting: (updater: (settings: Im.Draft<SS.ServerSettings>) => void) => void
	setQueue: Setter<LLState>
	tryStartEditing: () => void
	tryEndEditing: () => void

	setPoolApplyAs: (type: keyof QDStore['poolApplyAs'], value: LQY.LayerQueryConstraint['applyAs']) => void
	setHoveredConstraintItemId: React.Dispatch<React.SetStateAction<string | undefined>>
}

// -------- store initialization --------
export const createLLActions = (set: Setter<LLState>, get: Getter<LLState>, onMutate?: () => void): LLActions => {
	const remove = (id: string) => {
		set((prevState) =>
			Im.produce(prevState, (draft) => {
				let itemRes: LL.LayerListIteratorResult | undefined
				if (!(itemRes = LL.findItemById(prevState.layerList, id))) return
				LL.splice(draft.layerList, itemRes, 1)
				ItemMut.tryApplyMutation('removed', id, draft.listMutations)
				onMutate?.()
			})
		)
	}
	return {
		setItem: (id, update) => {
			set((state) => {
				return Im.produce(state, (draft) => {
					const itemResult = LL.findItemById(state.layerList, id)
					if (!itemResult) return
					const updated = typeof update === 'function' ? update(itemResult.item) : update
					LL.splice(draft.layerList, itemResult, 1, updated)
					ItemMut.tryApplyMutation('edited', id, draft.listMutations)
					onMutate?.()
				})
			})
		},
		add: (newItems, index) => {
			set(
				Im.produce((draft) => {
					const items = newItems.map(LL.createLayerListItem)
					index ??= { outerIndex: draft.layerList.length, innerIndex: null }
					LL.splice(draft.layerList, index, 0, ...items)
					for (const { item } of LL.iterLayerList(items)) {
						ItemMut.tryApplyMutation('added', item.itemId, draft.listMutations)
					}
					onMutate?.()
				}),
			)
		},
		move(movedItemId, targetCursor, modifiedBy) {
			set((state) => {
				console.debug('before', state)
				return Im.produce(state, (draft) => {
					if (movedItemId === targetCursor.itemId) return
					const targetCursorParent = LL.findParentItem(targetCursor.itemId, state.layerList)
					if (targetCursorParent?.itemId == movedItemId) return

					const movedItemRes = LL.findItemById(state.layerList, movedItemId)
					const targetItemRes = LL.findItemById(state.layerList, targetCursor.itemId)
					if (movedItemRes === undefined) {
						console.warn('Failed to move item. item not found', movedItemId, targetCursor.itemId)
						return
					}
					if (targetItemRes === undefined) {
						console.warn('Failed to move item. target item not found', movedItemId, targetCursor.itemId)
						return
					}

					{
						const cursorItemIndex = LL.resolveQualfiedIndexFromCursorForMove(state.layerList, targetCursor)
						if (cursorItemIndex === undefined) return

						if (cursorItemIndex.innerIndex === movedItemRes.innerIndex && cursorItemIndex.outerIndex === movedItemRes.outerIndex) {
							// already at target position
							return
						}
					}
					LL.splice(draft.layerList, movedItemRes, 1)
					switch (targetCursor.position) {
						case 'on': {
							const targetItemRes = LL.findItemById(state.layerList, targetCursor.itemId)
							if (!targetItemRes) return
							const mergedItem = LL.mergeItems(targetItemRes.item, movedItemRes.item)
							if (!mergedItem) throw new Error('Failed to merge items')
							LL.splice(draft.layerList, targetCursor, 1, mergedItem)
							ItemMut.tryApplyMutation('edited', mergedItem.itemId, draft.listMutations)
							break
						}
						case 'after':
						case 'before': {
							const movedAndModifiedItem: LL.LayerListItem = { ...movedItemRes.item, source: { type: 'manual', userId: modifiedBy } }
							LL.splice(draft.layerList, targetCursor, 0, movedAndModifiedItem)
							if (targetCursorParent && LL.isVoteChoiceResult(targetItemRes)) {
								ItemMut.tryApplyMutation('edited', targetCursorParent.itemId, draft.listMutations)
							}
							break
						}
						default: {
							assertNever(targetCursor.position)
						}
					}

					ItemMut.tryApplyMutation('moved', movedItemRes.item.itemId, draft.listMutations)
					onMutate?.()
				})
				console.debug('after', state)
			})
		},
		remove,
		clear: () => {
			const removed = new Set(get().layerList.map((item) => item.itemId))
			set({
				layerList: [],
				listMutations: { removed, added: new Set(), edited: new Set(), moved: new Set() },
			})
			onMutate?.()
		},
	}
}

export const selectLLState = (state: QDState): LLState => ({
	layerList: state.editedServerState.layerQueue,
	listMutations: state.queueMutations,
	nextLayerBackfillId:
		(state.serverState && LL.getNextLayerId(state.serverState?.layerQueue) === LL.getNextLayerId(state.editedServerState.layerQueue))
			? state.nextLayerBackfillId
			: undefined,
})

export const deriveLLStore = (store: Zus.StoreApi<QDStore>) => {
	const setLL = store.getState().setQueue
	const getLL = () => selectLLState(store.getState())
	const onMutate = () => {
		store.getState().tryStartEditing()
	}
	const actions = createLLActions(setLL, getLL, onMutate)

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
		swapFactions: () => {
			const item = get().item
			set({ item: LL.swapFactions(item) })
		},
		addVoteItems: (choices) => {
			const newItem = LL.mergeItems(get().item, ...choices.map(LL.createLayerListItem))
			if (!newItem) return
			set({ item: newItem })
		},
		remove: removeItem,
	}
}

export function useLLItemStore(llStore: Zus.StoreApi<LLStore>, itemId: LL.LayerListItemId) {
	const [store, subHandle] = React.useMemo(() => deriveLLItemStore(llStore, itemId), [llStore, itemId])
	React.useEffect(() => {
		const sub = subHandle.subscribe()
		return () => sub.unsubscribe()
	}, [subHandle])
	return store
}

export const deriveLLItemStore = (llStore: Zus.StoreApi<LLStore>, itemId: string) => {
	let subHandle!: { subscribe: () => Rx.Subscription }
	const store = Zus.createStore<LLItemStore>((set) => {
		const actions: LLItemActions = {
			setItem: (update) => llStore.getState().setItem(itemId, update),
			addVoteItems: (choices) => {
				const { item } = LL.findItemById(llStore.getState().layerList, itemId)!
				const newItem = LL.mergeItems(item, ...choices.map(LL.createLayerListItem))
				if (!newItem) return
				llStore.getState().setItem(item.itemId, newItem)
			},
			remove: () => llStore.getState().remove(itemId),
			swapFactions: () => {
				const { item } = LL.findItemById(llStore.getState().layerList, itemId)!
				llStore.getState().setItem(itemId, LL.swapFactions(item))
			},
		}
		function deriveState(llState: LLStore): LLItemState | null {
			const layerList = llState.layerList

			const res = LL.findItemById(layerList, itemId)
			if (!res) return null
			const parentItem = LL.findParentItem(itemId, layerList)
			const { item, outerIndex, innerIndex } = res
			return {
				index: outerIndex,
				innerIndex,
				isVoteChoice: innerIndex != null,
				item,
				mutationState: ItemMut.toItemMutationState(llState.listMutations, itemId, parentItem?.layerId),
			}
		}

		const derived$ = new Rx.Observable<LLItemState | null>((observer) => {
			const unsub = llStore.subscribe((state) => {
				observer.next(deriveState(state))
			})
			return () => unsub()
		})

		subHandle = {
			subscribe: () =>
				derived$.subscribe((state) => {
					if (state) set(state)
				}),
		}

		return {
			...actions,
			...deriveState(llStore.getState())!,
		}
	})
	return [store, subHandle] as const
}

export function getEditableServerState(state: SS.LQServerState): MutServerStateWithIds {
	return {
		layerQueue: state.layerQueue,
		layerQueueSeqId: state.layerQueueSeqId,
		settings: state.settings,
	}
}

export const initialQDState: QDState = {
	initialized: false,
	editedServerState: { layerQueue: [], layerQueueSeqId: 0, settings: SS.ServerSettingsSchema.parse({ queue: {} }) },
	queueMutations: ItemMut.initMutations(),
	serverState: null,
	isEditing: false,
	canEditQueue: false,
	canEditSettings: false,
	stopEditingInProgress: false,
	extraQueryFilters: new Set(),
	activeExtraQueryFilters: new Set(),
	poolApplyAs: {
		dnr: 'field',
		filter: 'where-condition',
	},
	hoveredConstraintItemId: undefined,
}

export const QDStore = Zus.createStore(subscribeWithSelector<QDStore>((set, get, store) => {
	const canEdit$ = userPresenceState$.pipe(
		Rx.mergeMap(async (state) => {
			const user = await UsersClient.fetchLoggedInUser()
			const canEdit = !state?.editState || state.editState.wsClientId === user?.wsClientId
			if (!user) return { canEditQueue: false, canEditSettings: false }
			return {
				canEditQueue: canEdit && RBAC.rbacUserHasPerms(user, { check: 'all', permits: [RBAC.perm('queue:write')] }),
				canEditSettings: canEdit && RBAC.rbacUserHasPerms(user, { check: 'all', permits: [RBAC.perm('settings:write')] }),
			}
		}),
		distinctDeepEquals(),
	)

	SquadServerClient.layersStatus$.subscribe(status => {
		set({ nextLayerBackfillId: (status.code === 'ok' && status.data.nextLayer) ? status.data.nextLayer.id : undefined })
	})

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
		const loggedInUser = await UsersClient.fetchLoggedInUser()
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
			const loggedInUser = await UsersClient.fetchLoggedInUser()
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
			editedServerState: Obj.deepClone(initialQDState.editedServerState),
			queueMutations: ItemMut.initMutations(),
		}
	}

	const extraQueryFilters = new Set(localStorage.getItem('extraQueryFilters:v2')?.split(',') ?? [])
	function writeExtraQueryFilters() {
		localStorage.setItem('extraQueryFilters:v2', Array.from(get().extraQueryFilters).join())
	}
	if (extraQueryFilters.size === 0) {
		;(async () => {
			const config = await ConfigClient.fetchConfig()
			const filterEntities = await FilterEntityClient.initializedFilterEntities$().getValue()
			if (!config.layerTable.defaultExtraFilters) return

			set({
				extraQueryFilters: new Set(config.layerTable.defaultExtraFilters.filter(f => filterEntities.has(f))),
			})
			writeExtraQueryFilters()
		})()
	}
	FilterEntityClient.filterEntityChanged$.subscribe(() => {
		const extraFilters = Array.from(get().extraQueryFilters).filter(f => FilterEntityClient.filterEntities.has(f))
		set({ extraQueryFilters: new Set(extraFilters) })
	})

	store.subscribe((state) => state?.extraQueryFilters, (state) => state && writeExtraQueryFilters())

	let maxQueueSize: number = 10
	fetchConfig().then(config => {
		maxQueueSize = config.maxQueueSize ?? 10
	})

	return {
		...initialQDState,
		extraQueryFilters,
		applyServerUpdate: (update) => {
			set({ serverState: update.state })
			get().reset().then(() => {
				set({ initialized: true })
			})
		},
		reset: async () => {
			const serverStateUpdate = await lqServerStateUpdate$.getValue()
			await tryEndEditing()
			if (!serverStateUpdate) {
				set({ ...getInitialStateToReset(), canEditQueue: get().canEditQueue, isEditing: get().isEditing })
				return
			}

			set({
				...getInitialStateToReset(),
				editedServerState: getEditableServerState(serverStateUpdate.state) ?? initialQDState.editedServerState,
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
		setHoveredConstraintItemId: (update) => {
			const previous = get().hoveredConstraintItemId
			const updated = typeof update === 'function' ? update(get().hoveredConstraintItemId) : update
			if (updated !== previous) set({ hoveredConstraintItemId: updated })
		},
	}
}))
// @ts-expect-error expose for debugging
window.QDStore = QDStore

export const [useLayerItemsState, layerItemsState$] = ReactRx.bind(
	Rx.combineLatest([
		ZusRx.toStream(QDStore),
		MatchHistoryClient.recentMatches$,
	]).pipe(
		Rx.filter(([qdState]) => {
			return qdState.initialized
		}),
		Rx.map(([qdState, history]) => {
			const state = LQY.resolveLayerItemsState(qdState.editedServerState.layerQueue, history)
			return state
		}),
		distinctDeepEquals(),
	),
)

export function setup() {
	layerItemsState$.subscribe()
}

export function getExtraFiltersConstraints(extraFiltersState: ExtraQueryFiltersState) {
	const constraints: LQY.LayerQueryConstraint[] = []
	for (const filterId of extraFiltersState.filters) {
		if (!extraFiltersState.active.has(filterId)) continue
		constraints.push({
			type: 'filter-entity',
			id: 'extra-filter:' + filterId,
			filterEntityId: filterId,
			applyAs: 'where-condition',
		})
	}
	return constraints
}

export function selectBaseQueryConstraints(state: QDState): LQY.LayerQueryConstraint[] {
	const queryConstraints = SS.getPoolConstraints(
		state.editedServerState.settings.queue.mainPool,
		state.poolApplyAs.dnr,
		state.poolApplyAs.filter,
	)

	return queryConstraints
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

export function useSaveChangesMutation() {
	const updateQueueMutation = useMutation({ mutationFn: saveLqState })
	const toaster = useToast()
	async function saveLqState() {
		const serverStateMut = QDStore.getState().editedServerState
		const res = await trpc.layerQueue.updateQueue.mutate(serverStateMut)
		const reset = QDStore.getState().reset
		switch (res.code) {
			case 'err:permission-denied':
				RbacClient.handlePermissionDenied(res)
				reset()
				break
			case 'err:out-of-sync':
				toaster.toast({
					title: 'State changed before submission, please try again.',
					variant: 'destructive',
				})
				reset()
				return
			case 'err:queue-change-during-vote':
				toaster.toast({
					title: 'Cannot update: layer vote in progress',
					variant: 'destructive',
				})
				reset()
				break
			case 'err:queue-too-large':
				toaster.toast({
					title: 'Queue too large',
					variant: 'destructive',
				})
				break
			case 'err:empty-vote':
				toaster.toast({
					title: 'Cannot update: vote is empty',
					variant: 'destructive',
				})
				break
			case 'err:too-many-vote-choices':
				toaster.toast({
					title: res.msg,
					variant: 'destructive',
				})
				break
			case 'err:duplicate-vote-choices':
				toaster.toast({
					title: res.msg,
					variant: 'destructive',
				})
				break
			case 'ok':
				toaster.toast({ title: 'Changes applied' })
				QDStore.getState().reset()
				break
			default:
				assertNever(res)
		}
	}

	return updateQueueMutation
}
