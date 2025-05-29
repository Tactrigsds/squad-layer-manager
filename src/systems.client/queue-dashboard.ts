import { globalToast$ } from '@/hooks/use-global-toast'
import { useToast } from '@/hooks/use-toast'
import { acquireInBlock, distinctDeepEquals } from '@/lib/async'
import * as FB from '@/lib/filter-builders'
import { ItemMutations, ItemMutationState } from '@/lib/item-mutations'
import * as ItemMut from '@/lib/item-mutations'
import { deepClone, selectProps } from '@/lib/object'
import * as SM from '@/lib/rcon/squad-models'
import { assertNever } from '@/lib/typeGuards'
import { Getter, Setter } from '@/lib/zustand'
import * as ZusUtils from '@/lib/zustand'
import * as M from '@/models'
import * as RBAC from '@/rbac.models'
import { lqServerStateUpdate$ } from '@/systems.client/layer-queue.client'
import * as RbacClient from '@/systems.client/rbac.client'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { trpc } from '@/trpc.client'
import { useMutation } from '@tanstack/react-query'
import { Mutex } from 'async-mutex'
import { derive } from 'derive-zustand'
import * as Im from 'immer'
import React from 'react'
import * as ReactRouterDOM from 'react-router-dom'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { fetchConfig } from './config.client'
import * as FilterEntityClient from './filter-entity.client'
import * as MatchHistoryClient from './match-history.client'
import { userPresenceState$, userPresenceUpdate$ } from './presence'
import * as UsersClient from './users.client'

// -------- types --------
export type MutServerStateWithIds = M.UserModifiableServerState & {
	layerQueue: M.LayerListItem[]
}

/**
 * Layer List State
 */
export type LLState = {
	layerList: M.LayerListItem[]

	// if this layer is set as the next one on the server but is only a partial, then we want to "backfill" the details that the server fills in for us. If this property is defined that indicates that we should attempt to backfill
	nextLayerBackfillId?: string
	listMutations: ItemMutations

	// the parity of the first item in a regular layer list, but if vote choice it's all items
	teamParity: number

	isVoteChoice?: boolean

	// this is usually just the main layer pool but for vote choice layer lists it could be more specific
	baseQueryContext: M.LayerQueryContext
}

export type LLStore = LLState & LLActions

export type LLActions = {
	move: (sourceIndex: number, targetIndex: number, modifiedBy: bigint) => void
	add: (items: M.NewLayerListItem[], index?: number) => void
	setItem: (id: string, update: React.SetStateAction<M.LayerListItem>) => void
	remove: (id: string) => void
	clear: () => void
}

export type LLItemState = {
	index: number
	item: M.LayerListItem
	teamParity: number
	mutationState: ItemMutationState
	baseQueryContext: M.LayerQueryContext
}

export type LLItemStore = LLItemState & LLItemActions

export type LLItemActions = {
	setItem: React.Dispatch<React.SetStateAction<M.LayerListItem>>
	swapFactions: () => void
	// if not present then removing is disabled
	remove?: () => void
}

export type ExtraQueryFilter = {
	filterId: M.FilterEntityId
	active: boolean
}

// Queue Dashboard state
export type QDState = {
	editedServerState: MutServerStateWithIds

	// if this layer is set as the next one on the server but is only a partial, then we want to "backfill" the details that the server fills in for us.
	nextLayerBackfillId?: string
	queueMutations: ItemMutations
	serverState: M.LQServerState | null
	isEditing: boolean
	stopEditingInProgress: boolean
	canEditQueue: boolean
	canEditSettings: boolean
	queueTeamParity: number
	poolApplyAs: {
		dnr: M.LayerQueryConstraint['applyAs']
		filter: M.LayerQueryConstraint['applyAs']
	}
	extraQueryFilters: ExtraQueryFilter[]
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
		setActive: (filterId: M.FilterEntityId, active: boolean) => void
		select: (newFilterId: M.FilterEntityId, oldFilterId: M.FilterEntityId) => void
		add: (newFilterId: M.FilterEntityId, active: boolean) => void
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

export const getVoteChoiceStateFromItem = (itemState: Pick<LLItemState, 'item' | 'teamParity' | 'baseQueryContext'>): LLState => {
	return {
		listMutations: ItemMut.initMutations(),
		layerList: itemState.item.vote?.choices.map(choice => M.createLayerListItem({ layerId: choice, source: itemState.item.source })) ?? [],
		isVoteChoice: true,
		teamParity: itemState.teamParity,
		baseQueryContext: itemState.baseQueryContext,
	}
}

export const getVoteChoiceStore = (itemState: Pick<LLItemState, 'item' | 'teamParity' | 'baseQueryContext'>) => {
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
	teamParity: state.queueTeamParity,
	nextLayerBackfillId:
		(state.serverState && M.getNextLayerId(state.serverState?.layerQueue) === M.getNextLayerId(state.editedServerState.layerQueue))
			? state.nextLayerBackfillId
			: undefined,
	baseQueryContext: {
		constraints: state.serverState
			? selectQDQueryConstraints(state)
			: undefined,
	},
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

function swapFactions(existingItem: M.LayerListItem) {
	const updated: M.LayerListItem = { ...existingItem, source: { type: 'manual', userId: UsersClient.logggedInUserId! } }
	if (existingItem.layerId) {
		const layerId = M.swapFactionsInId(existingItem.layerId)
		updated.layerId = layerId
	}
	if (existingItem.vote) {
		updated.vote = {
			...existingItem.vote,
			choices: existingItem.vote.choices.map(M.swapFactionsInId),
			defaultChoice: M.swapFactionsInId(existingItem.vote.defaultChoice),
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
		const baseQueryContext = get(store).baseQueryContext
		const firstItemTeamParity = get(store).teamParity
		if (isVoteChoice) {
			return {
				...actions,
				index,
				item: layerList[index],
				mutationState: ItemMut.toItemMutationState(get(store).listMutations, itemId),
				teamParity: firstItemTeamParity,
				baseQueryContext: { previousLayerIds: [], ...baseQueryContext },
			}
		}
		return {
			...actions,
			index,
			item: layerList[index],
			mutationState: ItemMut.toItemMutationState(get(store).listMutations, itemId),
			baseQueryContext,
			teamParity: SM.getTeamParityForOffset({ ordinal: firstItemTeamParity }, index + 1),
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
			baseQueryContext: state.baseQueryContext,
			teamParity: state.teamParity,
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
	return {
		layerQueue,
		layerQueueSeqId: state.layerQueueSeqId,
		settings: state.settings,
	}
}

export const initialState: QDState = {
	editedServerState: { layerQueue: [], layerQueueSeqId: 0, settings: M.ServerSettingsSchema.parse({ queue: {} }) },
	queueMutations: ItemMut.initMutations(),
	serverState: null,
	isEditing: false,
	canEditQueue: false,
	canEditSettings: false,
	queueTeamParity: 0,
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

	SquadServerClient.squadServerStatus$.subscribe(status => {
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
			editedServerState: deepClone(initialState.editedServerState),
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

	MatchHistoryClient.currentMatchDetails$().subscribe(details => {
		if (!details) return
		set({ queueTeamParity: SM.getTeamParityForOffset(details, 0) })
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
	}
})
// @ts-expect-error expose for debugging
window.QDStore = QDStore

export function selectQDQueryConstraints(state: QDState): M.LayerQueryConstraint[] {
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

export function selectLayerListQueryContext(
	state: Pick<LLState, 'layerList' | 'baseQueryContext' | 'isVoteChoice'>,
	// index can be up to and including the length of the list
	atIndex?: number,
): M.LayerQueryContext {
	const queueLayerIds = M.getAllLayerIdsFromList(state.layerList, { excludeVoteChoices: true })
	// points to next layer in queue past existing one
	atIndex = atIndex ?? state.layerList.length
	if (state.isVoteChoice) {
		let constraints = state.baseQueryContext.constraints
		const filter = FB.comp(FB.inValues('id', queueLayerIds.filter((id, idx) => idx !== atIndex)), { neg: true })
		constraints = [...(state.baseQueryContext.constraints ?? []), M.filterToConstraint(filter, 'vote-choice-sibling-exclusion' + atIndex)]
		return {
			previousLayerIds: state.baseQueryContext.previousLayerIds ?? [],
			constraints,
		}
	}

	return {
		...state.baseQueryContext,
		previousLayerIds: [...(state.baseQueryContext.previousLayerIds ?? []), ...queueLayerIds.slice(0, atIndex)],
	}
}

export function selectItemQueryContext(itemState: Pick<LLItemState, 'baseQueryContext' | 'index'>) {
	return {
		...itemState.baseQueryContext,
		previousLayerIds: itemState.baseQueryContext.previousLayerIds?.slice(0, itemState.index) ?? [],
	}
}

export function useLayerListItemQueryContext(itemStore: Zus.StoreApi<LLItemStore>): M.LayerQueryContext {
	const { baseQueryContext, index } = ZusUtils.useStoreDeep(itemStore, (s) => selectProps(s, ['baseQueryContext', 'index']))
	return {
		...baseQueryContext,
		previousLayerIds: baseQueryContext.previousLayerIds?.slice(0, index) ?? [],
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
