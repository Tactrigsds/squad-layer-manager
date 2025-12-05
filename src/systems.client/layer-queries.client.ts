import { globalToast$ } from '@/hooks/use-global-toast'
import { toAsyncGenerator } from '@/lib/async'
import * as Gen from '@/lib/generator'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import * as ZusUtils from '@/lib/zustand'
import * as CB from '@/models/constraint-builders'
import * as FB from '@/models/filter-builders'
import type * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as ConfigClient from '@/systems.client/config.client'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import type * as WorkerTypes from '@/systems.client/layer-queries.worker'
import * as React from 'react'

// oxlint-disable-next-line import/default
import LQWorker from '@/systems.client/layer-queries.worker?worker'
import * as QD from '@/systems.client/queue-dashboard'
import * as ServerSettingsClient from '@/systems.client/server-settings.client'
import * as UsersClient from '@/systems.client/users.client'

import { experimental_streamedQuery as streamedQuery, queryOptions, useQuery } from '@tanstack/react-query'
import * as Im from 'immer'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'

type LayerCtxModifiedCounters = { [k in keyof WorkerTypes.DynamicQueryCtx]: number }

export type Store = {
	counters: LayerCtxModifiedCounters
	increment: (ctx: Partial<WorkerTypes.DynamicQueryCtx>) => void
	extraQueryFilters: LQY.ExtraQueryFiltersState['extraFilters']
	setExtraQueryFilters(db: (draft: Im.WritableDraft<LQY.ExtraQueryFiltersState['extraFilters']>) => void): void
	hoveredConstraintItemId: string | null
	setHoveredConstraintItemId(id: LQY.ItemId | null): void
}

// we don't want to use the entire query context as query state so instead we just increment these counters whenever one of them change and depend on that instead
export const Store = Zus.createStore<Store>((set, get, store) => {
	const extraQueryFilters = new Set(localStorage.getItem('extraQueryFilters:v2')?.split(',') ?? [])
	if (extraQueryFilters.size === 0) {
		void (async () => {
			const config = await ConfigClient.fetchConfig()
			const filterEntities = await FilterEntityClient.initializedFilterEntities$().getValue()
			if (!config.layerTable.defaultExtraFilters) return

			set({
				extraQueryFilters: new Set(config.layerTable.defaultExtraFilters.filter(f => filterEntities.has(f))),
			})
		})()
	}

	store.subscribe((state, prev) => {
		const extraFilters = Array.from(state.extraQueryFilters)
		const prevExtraFilters = Array.from(prev.extraQueryFilters)
		if (!Obj.deepEqual(extraFilters, prevExtraFilters)) {
			localStorage.setItem('extraQueryFilters:v2', extraFilters.join(','))
		}
	})

	return ({
		counters: {
			filters: 0,
			layerItemsState: 0,
		},
		hoveredConstraintItemId: null,
		extraQueryFilters,
		setExtraQueryFilters(cb) {
			set(state => {
				const newState = Im.produce(state, draft => {
					cb(draft.extraQueryFilters)
				})
				return newState
			})
		},
		increment(ctx) {
			for (const key of Obj.objKeys(ctx)) {
				set({ counters: { ...get().counters, [key]: get().counters[key] + 1 } })
			}
		},
		setHoveredConstraintItemId(id: string | null) {
			set({ hoveredConstraintItemId: id })
		},
	})
})

export const useIsFetchingLayerData = Zus.create(() => false)

function getIsLayerDisabled(layerData: RowData, canForceSelect: boolean, constraints: LQY.Constraint[]) {
	return !canForceSelect && layerData.constraints.values?.some((v, i) => !v && constraints[i].type !== 'do-not-repeat')
}

export type ConstraintRowDetails = {
	values: boolean[]
	matchDescriptors: LQY.MatchDescriptor[]
	queriedConstraints: LQY.Constraint[]
	matchedConstraintIds: string[]
	matchedConstraintDescriptors: LQY.MatchDescriptor[]
}
export type RowData = L.KnownLayer & Record<string, any> & { 'constraints': ConstraintRowDetails; 'isRowDisabled': boolean }
/**
 * Convert a layer to RowData format with constraints and isRowDisabled computed
 */
function layerToRowData(
	layer: any,
	userCanForceSelect: boolean,
	queriedConstraints: LQY.Constraint[],
): RowData {
	// TODO  this is madness
	const constraintValues = Array.isArray(layer.constraints)
		? layer.constraints
		: layer.constraints?.values ?? []

	const matchDescriptors = Array.isArray(layer.matchDescriptors)
		? layer.matchDescriptors
		: layer.matchDescriptors ?? []

	const matchedConstraintIds = queriedConstraints.flatMap((c, i) => {
		if (constraintValues[i]) return [c.id]
		return []
	})
	const matchedConstraintDescriptors = matchDescriptors

	const constraints: ConstraintRowDetails = {
		values: constraintValues,
		matchDescriptors,
		queriedConstraints,
		matchedConstraintIds,
		matchedConstraintDescriptors,
	}

	const isRowDisabled = !userCanForceSelect && getIsLayerDisabled({ ...layer, constraints }, userCanForceSelect, queriedConstraints)

	return {
		...layer,
		constraints,
		isRowDisabled,
	} as RowData
}

export type QueryLayersPageData = {
	layers: RowData[]
	totalCount: number
	pageCount: number
	input: LQY.LayersQueryInput
}
export type QueryLayersInputOpts = {
	cfg?: LQY.EffectiveColumnAndTableConfig
	selectedLayers?: L.LayerId[]
	sort?: LQY.LayersQueryInput['sort']
	pageSize?: number
	pageIndex?: number
}

export type QueryLayersPacket =
	| { code: 'layers-page' } & QueryLayersPageData
	| { code: 'menu-item-possible-values'; values: Record<string, string[]> }

export function getQueryLayersOptions(
	baseInput: LQY.BaseQueryInput,
	inputOpts: QueryLayersInputOpts,
	// cringe but works for now. tanstack query makes it hard to get at the stream otherwise
	packet$?: Rx.Subject<QueryLayersPacket>,
	errorStore?: Zus.StoreApi<F.NodeValidationErrorStore>,
	counters?: LayerCtxModifiedCounters,
) {
	counters = counters ?? Store.getState().counters
	const input = getQueryLayersInput(baseInput, inputOpts)
	async function* streamLayersQuery() {
		try {
			for await (const res of streamLayerQueriesResponse(input)) {
				if (res.code === 'err:invalid-node') {
					console.error('queryLayers: Invalid node error:', res.errors)
					errorStore?.setState({ errors: res.errors })
					throw new Error('Invalid node')
				} else {
					errorStore?.setState({ errors: undefined })
				}
				if (res.code === 'menu-item-possible-values') {
					packet$?.next(res)
					yield res
					continue
				}

				const user = await UsersClient.fetchLoggedInUser()
				const userCanForceSelect = RBAC.rbacUserHasPerms(user, RBAC.perm('queue:force-write'))
				let page = {
					...res,
					input,
				}
				if (input.selectedLayers) {
					const layerIdsForPage = input.selectedLayers.slice(
						(input.pageIndex ?? 0) * input.pageSize,
						((input.pageIndex ?? 0) * input.pageSize) + input.pageSize,
					)
					const selectedLayers: RowData[] = layerIdsForPage.map((id) => {
						const layer = page!.layers.find(l => l.id === id)
						if (layer) {
							return layerToRowData(layer, userCanForceSelect, input.constraints ?? [])
						}
						const newLayer: any = {
							...L.toLayer(id),
							constraints: Array(input.constraints?.length ?? 0).fill(false),
							matchDescriptors: [],
						}
						return layerToRowData(newLayer, userCanForceSelect, input.constraints ?? [])
					})
					if (input.sort) {
						;(selectedLayers as Record<string, any>[]).sort((a: any, b: any) => {
							const sort = input.sort!
							if (sort.type === 'random') {
								// For random sort just shuffle the entries
								return Math.random() - 0.5
							} else if (sort.type === 'column') {
								const column = sort.sortBy
								const direction = sort.direction === 'ASC' ? 1 : -1

								if (a[column] === b[column]) return 0
								if (a[column] === null || a[column] === undefined) return direction
								if (b[column] === null || b[column] === undefined) return -direction

								return a[column] < b[column] ? -direction : direction
							} else {
								assertNever(sort)
							}
						})
					}
					page = { ...page, layers: selectedLayers as any }
				}
				if (page) {
					const packet = {
						...page,
						layers: page.layers?.map((layer: any) => layerToRowData(layer, userCanForceSelect, input.constraints ?? [])),
					}
					packet$?.next(packet)
					yield packet
				}
			}
		} finally {
			packet$?.complete()
		}
	}
	return queryOptions({
		queryKey: ['layers', '__queryLayers__', getDepKey(input, counters)],
		queryFn: streamedQuery({ queryFn: streamLayersQuery }),
		staleTime: Infinity,
	})
}

function getQueryLayersInput(baseInput: LQY.BaseQueryInput, opts: QueryLayersInputOpts): LQY.LayersQueryInput {
	let sort = opts?.sort ?? opts.cfg?.defaultSortBy ?? LQY.DEFAULT_SORT
	if (sort?.type === 'random' && !sort.seed) {
		console.error('Random sort requires a random seed when used with react query')
		sort = { ...sort, seed: 'SUPER_RANDOM_SEED' }
	}
	const pageSize = opts.pageSize ?? LQY.DEFAULT_PAGE_SIZE
	const pageIndex = opts.pageIndex ?? 0
	const selectedLayers = opts.selectedLayers
	if (baseInput.cursor && !baseInput.action) {
		baseInput = { ...baseInput, action: 'add' }
	}

	if (selectedLayers) {
		const filter = FB.comp(
			FB.inValues('id', selectedLayers.filter(layer => LC.isKnownAndValidLayer(layer, opts.cfg))),
		)
		baseInput = {
			...baseInput,
			constraints: [
				...(baseInput.constraints?.filter(c => !c.filterResults) ?? []),
				CB.filterAnon('show-selected', filter),
			],
		}
	}

	return {
		...baseInput,
		pageIndex,
		sort,
		pageSize,
		selectedLayers: selectedLayers,
	}
}

export function useLayerComponents(
	input: LQY.LayerComponentInput,
	options?: { enabled?: boolean; errorStore?: Zus.StoreApi<F.NodeValidationErrorStore> },
) {
	options ??= {}
	return useQuery({
		...options,
		queryKey: ['layers', 'queryLayerComponents', useDepKey(input)],
		enabled: options?.enabled,
		queryFn: async () => {
			const res = await sendWorkerRequest('queryLayerComponent', input)
			if (Array.isArray(res)) return res
			if (res?.code === 'err:invalid-node') {
				console.error('queryLayerComponents: Invalid node error:', res.errors)
				options?.errorStore?.setState({ errors: res.errors })
				throw new Error(res.code + ': ' + JSON.stringify(res.errors))
			} else if (options.errorStore) {
				options.errorStore.setState({ errors: undefined })
			}
			return res
		},
		staleTime: Infinity,
	})
}

export function useLayerItemStatusConstraints() {
	return ZusUtils.useStoreDeep(
		ServerSettingsClient.Store,
		state => QD.selectQueueStatusConstraints(state.saved),
		{
			dependencies: [],
		},
	)
}
function filterAndReportInvalidDescriptors(
	allConstraints: LQY.Constraint[],
	matchDescriptors: LQY.MatchDescriptor[] | undefined,
) {
	if (!matchDescriptors) return undefined

	const validDescriptors: LQY.MatchDescriptor[] = []
	for (let i = 0; i < matchDescriptors.length; i++) {
		if (!allConstraints.some(c => c.id === matchDescriptors[i].constraintId)) {
			console.error(`Matched constraint ${matchDescriptors[i].constraintId} is not present in the system`)
		} else {
			validDescriptors.push(matchDescriptors[i])
		}
	}
	return validDescriptors.length > 0 ? validDescriptors : undefined
}
export type LayerItemStatusData = {
	present: Set<LQY.ItemId>
	queriedConstraints: LQY.Constraint[]
	matchingConstraintIds: string[]
	matchingDescriptors: LQY.MatchDescriptor[]
	highlightedMatchDescriptors?: LQY.MatchDescriptor[]
}

export function useLayerItemStatusData(
	layerItem: LQY.LayerItem | LQY.ItemId,
	options?: { enabled?: boolean; errorStore?: Zus.StoreApi<F.NodeValidationErrorStore> },
): LayerItemStatusData | null {
	const queriedConstraints = useLayerItemStatusConstraints()
	const queryRes = useLayerItemStatuses(queriedConstraints, options)
	const itemId = LQY.resolveId(layerItem)

	const allMatchDescriptors = queryRes.data?.matchDescriptors
	const presentLayers = queryRes.data?.present

	const highlightedMatchDescriptors = Zus.useStore(
		Store,
		ZusUtils.useDeep(React.useCallback((store) => {
			if (!allMatchDescriptors) return
			const hoveredConstraintItemId = store.hoveredConstraintItemId ?? undefined
			const hoveredMatchDescriptors = hoveredConstraintItemId && hoveredConstraintItemId !== itemId
					&& filterAndReportInvalidDescriptors(
						queriedConstraints,
						allMatchDescriptors.get(hoveredConstraintItemId)?.filter(vd => vd.itemId === itemId),
					)
				|| undefined

			const localMatchDescriptors = hoveredConstraintItemId === itemId
					&& filterAndReportInvalidDescriptors(
						queriedConstraints,
						allMatchDescriptors.get(itemId),
					)
				|| undefined

			return localMatchDescriptors ?? hoveredMatchDescriptors
		}, [
			allMatchDescriptors,
			itemId,
			queriedConstraints,
		])),
	)

	return React.useMemo(() => {
		if (!allMatchDescriptors || !presentLayers) return null
		const matchingDescriptors = filterAndReportInvalidDescriptors(
			queriedConstraints,
			allMatchDescriptors.get(itemId),
		) ?? []

		const matchingConstraintIds = matchingDescriptors.map(c => c.constraintId)

		return {
			present: presentLayers,
			queriedConstraints,
			matchingConstraintIds,
			matchingDescriptors,
			highlightedMatchDescriptors,
		}
	}, [
		highlightedMatchDescriptors,
		allMatchDescriptors,
		itemId,
		presentLayers,
		queriedConstraints,
	])
}

// TODO prefetching
export function useLayerItemStatuses(
	constraints: LQY.Constraint[],
	options?: { enabled?: boolean; errorStore?: Zus.StoreApi<F.NodeValidationErrorStore> },
) {
	options ??= {}
	const input: LQY.LayerItemStatusesInput = { constraints }
	return useQuery({
		...options,
		queryKey: [
			'layers',
			'getLayerStatusesForLayerQueue',
			useDepKey(input),
		],
		enabled: options?.enabled,
		placeholderData: prev => prev,
		queryFn: async () => {
			// const counters = layerCtxVersionStore.getState().counters
			// if the layer context changes we can't trust the parts anymore
			// const layerContextUnchanged = Object.values(counters).every(c => c === 0)
			// if (!QD.QDStore.getState().isEditing && layerContextUnchanged) {
			// 	return PartsSys.getServerLayerItemStatuses()
			// }
			const res = await sendWorkerRequest('getLayerItemStatuses', input)
			if (res.code === 'err:invalid-node') {
				console.error('getLayerItemStatuses: Invalid node error:', res.errors)
				options?.errorStore?.setState({ errors: res.errors })
				throw new Error('err:invalid-node: ' + JSON.stringify(res.errors))
			}
			return res.statuses
		},
		staleTime: Infinity,
	})
}

export function useLayerExists(
	input?: LQY.LayerExistsInput,
	options?: { enabled?: boolean; usePlaceholderData?: boolean },
) {
	options ??= {}
	return useQuery({
		enabled: input && options?.enabled !== false,
		placeholderData: options?.usePlaceholderData ? (d) => d : undefined,
		queryKey: ['layers', 'layerExists', useDepKey(input)],
		queryFn: async () => {
			return await sendWorkerRequest('layerExists', input!)
		},
		staleTime: Infinity,
	})
}

export function useDepKey(input?: unknown) {
	const ctxCounters = Zus.useStore(Store, useShallow(s => s.counters))
	return getDepKey(input, ctxCounters)
}

// get context/input that may invalidate the query
function getDepKey(input: unknown, ctxCounters: LayerCtxModifiedCounters) {
	return {
		input,
		ctxCounters,
	}
}

/**
 * Static configuration for query priorities.
 * Lower numbers = higher priority (processed first).
 */
export const QUERY_PRIORITIES: Record<WorkerTypes.RequestInner['type'], number> = {
	'context-update': 5,
	'init': 5,
	getLayerItemStatuses: 4,
	queryLayers: 3,
	layerExists: 2,
	getLayerInfo: 2,
	queryLayerComponent: 1,
} as const

const seqIdCounter = Gen.counter()
function getSeqId() {
	return seqIdCounter.next().value
}

let worker!: Worker

async function sendWorkerRequest<T extends WorkerTypes.Request['type']>(
	type: T,
	input: Extract<WorkerTypes.Request, { type: T }>['input'],
	_priority?: number,
): Promise<Extract<WorkerTypes.Response, { type: T }>['payload']> {
	if (type !== 'init') await ensureFullSetup()

	const seqId = getSeqId()

	// Get priority from configuration
	const priority = _priority ?? QUERY_PRIORITIES[type] ?? 0

	const message = { type, input, seqId, priority }

	worker.postMessage(message)

	const response$ = Rx.fromEvent(worker, 'message').pipe(Rx.concatMap((e: any) => {
		const response = e.data as WorkerTypes.Response
		if (response.seqId !== seqId) {
			return Rx.EMPTY
		}

		if (response.type === 'worker-error') {
			const error = new Error('error from worker: ' + response.error)
			globalToast$.next({ variant: 'destructive', description: error.message })
			throw error
		}

		if (response.type !== type) {
			const error = new Error(`Unexpected response type: ${response.type}`)
			globalToast$.next({ variant: 'destructive', description: error.message })
			throw error
		}

		return Rx.of(response.payload)
	}))

	return (await Rx.firstValueFrom(response$)) as any
}

async function* streamLayerQueriesResponse(input: LQY.LayersQueryInput) {
	await ensureFullSetup()

	const seqId = getSeqId()

	const message: WorkerTypes.Request = {
		type: 'queryLayers',
		input,
		seqId,
		priority: QUERY_PRIORITIES.queryLayers,
	}

	worker.postMessage(message)

	const response$ = Rx.fromEvent(worker, 'message').pipe(
		Rx.concatMap((e: any) => {
			const response = e.data as WorkerTypes.Response
			if (response.seqId !== seqId) {
				return Rx.EMPTY
			}

			if (response.type === 'worker-error') {
				const error = new Error('error from worker: ' + response.error)
				globalToast$.next({ variant: 'destructive', description: error.message })
				throw error
			}

			if (response.type !== 'queryLayers') {
				const error = new Error(`Unexpected response type: ${response.type}`)
				globalToast$.next({ variant: 'destructive', description: error.message })
				throw error
			}

			return Rx.of(response.payload)
		}),
		Rx.takeWhile(e => e.code !== 'end'),
	)

	yield* toAsyncGenerator(response$)
}

let setup$: Promise<void> | null = null
export async function ensureFullSetup() {
	if (setup$) return await setup$
	setup$ = setup()
	await setup$
}

async function setup() {
	worker = new LQWorker({ name: 'layer-queries-worker' })
	FilterEntityClient.filterEntityChanged$.subscribe(() => {
		const extraFilters = Array.from(Store.getState().extraQueryFilters).filter(f => FilterEntityClient.filterEntities.has(f)).sort()
		const currentExtraFilters = Array.from(Store.getState().extraQueryFilters).sort()
		if (!Obj.deepEqual(extraFilters, currentExtraFilters)) {
			Store.setState({ extraQueryFilters: new Set(extraFilters) })
		}
	})

	const config = await ConfigClient.fetchConfig()

	const filters = await Rx.firstValueFrom(FilterEntityClient.initializedFilterEntities$())
	const itemsState = await Rx.firstValueFrom(QD.layerItemsState$)

	const ctx: WorkerTypes.InitRequest['input'] = {
		effectiveColsConfig: LC.getEffectiveColumnConfig(config.extraColumnsConfig),
		filters,
		layerItemsState: itemsState,
	}

	const initPromise = sendWorkerRequest('init', ctx)
	// the follwing depends on the initPromise messages already having been sent during workerPool.initialize, otherwise we may send context-updates before initialization
	const contextUpdate$ = Rx.merge(
		FilterEntityClient.filterEntities$.pipe(Rx.map(filters => ({ filters }))),
		QD.layerItemsState$.pipe(Rx.map(itemsState => ({ layerItemsState: itemsState }))),
	)

	contextUpdate$.pipe(Rx.observeOn(Rx.asyncScheduler)).subscribe(ctx => {
		void sendWorkerRequest('context-update', ctx)
		Store.getState().increment(ctx)
	})
	await initPromise
	console.log('Layers loaded')
	// Set up window focus handlers after successful initialization
	// const focusHandlers = setupWindowFocusHandlers()
}

export function getLayerInfoQueryOptions(layer: L.LayerId | L.KnownLayer) {
	const input = { layerId: typeof layer === 'string' ? layer : layer.id }
	return RPC.orpc.layerQueries.getLayerInfo.queryOptions({ input, staleTime: Infinity })
}

export function fetchLayerInfo(layer: L.LayerId | L.KnownLayer) {
	return RPC.queryClient.getQueryCache().build(RPC.queryClient, getLayerInfoQueryOptions(layer)).fetch()
}
