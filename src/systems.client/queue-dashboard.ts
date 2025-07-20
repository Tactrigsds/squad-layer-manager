import { globalToast$ } from '@/hooks/use-global-toast'
import { useToast } from '@/hooks/use-toast'
import { acquireInBlock, distinctDeepEquals } from '@/lib/async'
import { ItemMutations, ItemMutationState } from '@/lib/item-mutations'
import * as ItemMut from '@/lib/item-mutations'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import { Getter, Setter } from '@/lib/zustand'
import * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as MH from '@/models/match-history.models'
import * as SS from '@/models/server-state.models'
import * as RBAC from '@/rbac.models'
import { lqServerStateUpdate$ } from '@/systems.client/layer-queue.client'
import * as MatchHistoryClient from '@/systems.client/match-history.client'
import * as RbacClient from '@/systems.client/rbac.client'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import { useMutation } from '@tanstack/react-query'
import { Mutex } from 'async-mutex'
import { derive } from 'derive-zustand'
import * as Im from 'immer'
import React from 'react'
import * as ReactRouterDOM from 'react-router-dom'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import * as ZusRx from 'zustand-rx'
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

	isVoteChoice?: boolean
}

export type LLStore = LLState & LLActions

export type LLActions = {
	move: (sourceIndex: number, targetIndex: number, modifiedBy: bigint) => void
	add: (items: LL.NewLayerListItem[], index?: number) => void
	setItem: (id: string, update: React.SetStateAction<LL.LayerListItem>) => void
	remove: (id: string) => void
	clear: () => void
}

export type LLItemState = {
	index: number
	item: LL.LayerListItem
	mutationState: ItemMutationState
}

export type LLItemStore = LLItemState & LLItemActions

export type LLItemActions = {
	setItem: React.Dispatch<React.SetStateAction<LL.LayerListItem>>
	swapFactions: () => void
	// if not present then removing is disabled
	remove?: () => void
}

export type ExtraQueryFilter = {
	filterId: F.FilterEntityId
	active: boolean
}

// Queue Dashboard state
export type QDState = {
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
	extraQueryFilters: ExtraQueryFilter[]

	// M.toQueueLayerKey and stuff to lookup the id
	hoveredConstraintItemId?: string
}

export type QDStore = QDState & {
	applyServerUpdate: (update: SS.LQServerStateUpdate) => void
	reset: () => void
	setSetting: (updater: (settings: Im.Draft<SS.ServerSettings>) => void) => void
	setQueue: Setter<LLState>
	tryStartEditing: () => void
	tryEndEditing: () => void

	setPoolApplyAs: (type: keyof QDStore['poolApplyAs'], value: LQY.LayerQueryConstraint['applyAs']) => void

	extraQueryFilterActions: {
		setActive: (filterId: F.FilterEntityId, active: boolean) => void
		select: (newFilterId: F.FilterEntityId, oldFilterId: F.FilterEntityId) => void
		add: (newFilterId: F.FilterEntityId, active: boolean) => void
		remove: (filterId: F.FilterEntityId) => void
	}

	setHoveredConstraintItemId: React.Dispatch<React.SetStateAction<string | undefined>>
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
					const items = newItems.map(LL.createLayerListItem)
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

export const getVoteChoiceStateFromItem = (itemState: Pick<LLItemState, 'item'>): LLState => {
	return {
		listMutations: ItemMut.initMutations(),
		layerList: itemState.item.vote?.choices.map(choice => LL.createLayerListItem({ layerId: choice, source: itemState.item.source })) ?? [],
		isVoteChoice: true,
	}
}

export const getVoteChoiceStore = (itemState: Pick<LLItemState, 'item'>) => {
	const initialState = getVoteChoiceStateFromItem(itemState)
	return Zus.createStore<LLStore>((set, get) => ({
		...createLLActions(set, get),
		...initialState,
	}))
}

export const useVoteChoiceStore = (itemStore: Zus.StoreApi<LLItemStore>) => {
	// notably we're not syncing and state from itemStore here
	const newStore = React.useMemo(() => getVoteChoiceStore(itemStore.getState()), [itemStore])
	const [store, _setStore] = React.useState<Zus.StoreApi<LLStore>>(newStore)

	const initialRef = React.useRef(false)
	React.useEffect(() => {
		if (initialRef.current) return
		initialRef.current = true
		_setStore(newStore)
	}, [newStore])

	return store
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
		swapFactions: () => {
			const item = get().item
			set({ item: swapFactions(item) })
		},
		remove: removeItem,
	}
}

function swapFactions(existingItem: LL.LayerListItem) {
	const updated: LL.LayerListItem = { ...existingItem, source: { type: 'manual', userId: UsersClient.logggedInUserId! } }
	if (existingItem.layerId) {
		const layerId = L.swapFactionsInId(existingItem.layerId)
		updated.layerId = layerId
	}
	if (existingItem.vote) {
		updated.vote = {
			...existingItem.vote,
			choices: existingItem.vote.choices.map(L.swapFactionsInId),
			defaultChoice: L.swapFactionsInId(existingItem.vote.defaultChoice),
		}
	}
	return updated
}

export const deriveLLItemStore = (store: Zus.StoreApi<LLStore>, itemId: string) => {
	const actions: LLItemActions = {
		setItem: (update) => store.getState().setItem(itemId, update),
		remove: () => store.getState().remove(itemId),
		swapFactions: () => {
			const item = store.getState().layerList.find((item) => item.itemId === itemId)!
			store.getState().setItem(itemId, swapFactions(item))
		},
	}

	return derive<LLItemStore>((get) => {
		const layerList = get(store).layerList
		const index = layerList.findIndex((item) => item.itemId === itemId)
		const isVoteChoice = get(store).isVoteChoice
		if (isVoteChoice) {
			return {
				...actions,
				index,
				item: layerList[index],
				mutationState: ItemMut.toItemMutationState(get(store).listMutations, itemId),
			}
		}
		return {
			...actions,
			index,
			item: layerList[index],
			mutationState: ItemMut.toItemMutationState(get(store).listMutations, itemId),
		}
	})
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

export function getEditableServerState(state: SS.LQServerState): MutServerStateWithIds {
	const layerQueue = state.layerQueue
	return {
		layerQueue,
		layerQueueSeqId: state.layerQueueSeqId,
		settings: state.settings,
	}
}

export const initialState: QDState = {
	editedServerState: { layerQueue: [], layerQueueSeqId: 0, settings: SS.ServerSettingsSchema.parse({ queue: {} }) },
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
	hoveredConstraintItemId: undefined,
}

export const QDStore = Zus.createStore<QDStore>((set, get) => {
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
			editedServerState: Obj.deepClone(initialState.editedServerState),
			queueMutations: ItemMut.initMutations(),
		}
	}

	const extraQueryFilters = JSON.parse(localStorage.getItem('extraQueryFilters:v1') ?? '[]') as ExtraQueryFilter[]
	function writeExtraQueryFilters() {
		localStorage.setItem('extraQueryFilters:v1', JSON.stringify(get().extraQueryFilters))
	}
	FilterEntityClient.filterEntityChanged$.subscribe(() => {
		const toWrite: ExtraQueryFilter[] = []
		for (const extraFilter of extraQueryFilters) {
			if (FilterEntityClient.filterEntities.has(extraFilter.filterId)) {
				toWrite.push(extraFilter)
			}
		}

		set({ extraQueryFilters: toWrite })
		writeExtraQueryFilters()
	})

	let maxQueueSize: number = 10
	fetchConfig().then(config => {
		maxQueueSize = config.maxQueueSize ?? 10
	})

	return {
		...initialState,
		extraQueryFilters,
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
			setActive(filterId, active) {
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
				writeExtraQueryFilters()
			},
			select(newFilterId, oldFilterId) {
				set(state =>
					Im.produce(state, draft => {
						const existing = draft.extraQueryFilters.find(f => f.filterId === oldFilterId)
						if (existing) {
							existing.filterId = newFilterId
						} else {
							console.warn(`Filter ${oldFilterId} not found`)
						}
					})
				)
				writeExtraQueryFilters()
			},
			add(filterId) {
				set(state =>
					Im.produce(state, draft => {
						const existing = draft.extraQueryFilters.find(f => f.filterId === filterId)
						if (!existing) {
							draft.extraQueryFilters.push({ filterId, active: true })
						}
					})
				)
				writeExtraQueryFilters()
			},
			remove(filterId) {
				set(state =>
					Im.produce(state, draft => {
						const existingIdx = draft.extraQueryFilters.findIndex(f => f.filterId === filterId)
						if (existingIdx === -1) return
						draft.extraQueryFilters.splice(existingIdx, 1)
					})
				)
				writeExtraQueryFilters()
			},
		},
		setHoveredConstraintItemId: (update) => {
			const previous = get().hoveredConstraintItemId
			const updated = typeof update === 'function' ? update(get().hoveredConstraintItemId) : update
			if (updated !== previous) set({ hoveredConstraintItemId: updated })
		},
	}
})
// @ts-expect-error expose for debugging
window.QDStore = QDStore

export const [useLayerItemsState, layerItemsState$] = ReactRx.bind(
	Rx.combineLatest([
		ZusRx.toStream(QDStore),
		MatchHistoryClient.recentMatches$,
	]).pipe(
		Rx.map(([qdState, history]) => LQY.resolveLayerItemsState(qdState.editedServerState.layerQueue, history)),
		distinctDeepEquals(),
	),
)

export function setup() {
	layerItemsState$.subscribe()
}

export function selectBaseQueryConstraints(state: QDState): LQY.LayerQueryConstraint[] {
	const queryConstraints = SS.getPoolConstraints(
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
			case 'err:default-choice-not-in-choices':
				toaster.toast({
					title: 'Cannot update: default choice must be one of the vote choices',
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
