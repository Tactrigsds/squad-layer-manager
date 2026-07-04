import type * as SquadServerFrame from '@/frames/squad-server.frame'
import { globalToast$ } from '@/hooks/use-global-toast'
import { toAsyncGenerator } from '@/lib/async'
import * as Gen from '@/lib/generator'
import * as Obj from '@/lib/object'
import { assertNever } from '@/lib/type-guards'
import * as ZusUtils from '@/lib/zustand'
import * as CB from '@/models/constraint-builders'
import * as CS from '@/models/context-shared'
import * as FB from '@/models/filter-builders'
import type * as F from '@/models/filter.models'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import * as SETTINGS from '@/models/settings.models'
import * as RPC from '@/orpc.client'
import * as RBAC from '@/rbac.models'
import * as ConfigClient from '@/systems/config.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import type * as WorkerTypes from '@/systems/layer-queries.worker'
import * as React from 'react'
// oxlint-disable-next-line import/default
import LQWorker from '@/systems/layer-queries.worker?worker'
import * as UsersClient from '@/systems/users.client'
import { useQuery } from '@tanstack/react-query'
import * as Im from 'immer'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'

export type Store = {
	filtersModifiedEpoch: number
	incrementFiltersModifiedEpoch: () => void
	hoveredConstraintItemId: string | null
	status: 'uninitialized' | 'initializing' | 'downloading-layers' | 'ready' | 'error'
	errorMessage: string | null
	setStatus: (status: 'initializing' | 'downloading-layers' | 'ready' | 'error', errorMessage?: string) => void
}

// we don't want to use the entire query context as query state so instead we just increment these counters whenever one of them change and depend on that instead
export const Store = Zus.createStore<Store>((set, get, store) => {
	return ({
		filtersModifiedEpoch: 0,
		hoveredConstraintItemId: null,
		incrementFiltersModifiedEpoch() {
			set({ filtersModifiedEpoch: get().filtersModifiedEpoch + 1 })
		},
		status: 'uninitialized',
		errorMessage: null,
		setStatus(status, errorMessage) {
			set({ status, errorMessage: errorMessage ?? null })
		},
	})
})

export namespace Actions {
	export function setHoveredConstraintItemId(id: LQY.ItemId | null) {
		Store.setState({ hoveredConstraintItemId: id as string | null })
	}
}

function getIsLayerDisabled(layerData: RowData, canForceSelect: boolean, constraints: LQY.Constraint[]) {
	return !canForceSelect && layerData.constraints.values?.some((v, i) => !v && constraints[i].type !== 'do-not-repeat')
}

export type ConstraintRowDetails = {
	values: boolean[]
	matchDescriptors: LQY.MatchDescriptor[]
	queriedConstraints: LQY.Constraint[]
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

	const matchedConstraintDescriptors = matchDescriptors

	const constraints: ConstraintRowDetails = {
		values: constraintValues,
		matchDescriptors,
		queriedConstraints,
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

async function* streamQueryLayersPackets(input: LQY.LayersQueryInput): AsyncGenerator<QueryLayersPacket> {
	for await (const res of streamLayerQueriesResponse(input)) {
		if (res.code === 'err:invalid-node') {
			console.error('queryLayers: Invalid node error:', res.errors)
			throw new Error('Invalid node')
		} else if (res.code === 'err:missing-item-states') {
			throw new Error('err:missing-item-states')
		}
		if (res.code === 'menu-item-possible-values') {
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
			yield {
				...page,
				layers: page.layers?.map((layer: any) => layerToRowData(layer, userCanForceSelect, input.constraints ?? [])),
			}
		}
	}
}

// replaces the react-query cache for layer page queries: each entry is a shareReplay'd packet stream, so
// completed results replay synchronously and concurrent subscribers (e.g. prefetch + table) share one worker query
const queryLayersCache = new Map<string, Rx.Observable<QueryLayersPacket>>()
const QUERY_LAYERS_CACHE_MAX_ENTRIES = 50

// starts the query eagerly on first call for a given input; the returned observable replays all packets
export function queryLayers$(input: LQY.LayersQueryInput): Rx.Observable<QueryLayersPacket> {
	const key = JSON.stringify(getDepKey(input, Store.getState().filtersModifiedEpoch))
	let packet$ = queryLayersCache.get(key)
	if (!packet$) {
		packet$ = Rx.from(streamQueryLayersPackets(input)).pipe(Rx.shareReplay())
		queryLayersCache.set(key, packet$)
		// kick off the query immediately; drop failed queries so the next subscriber retries
		packet$.subscribe({ error: () => queryLayersCache.delete(key) })
		while (queryLayersCache.size > QUERY_LAYERS_CACHE_MAX_ENTRIES) {
			queryLayersCache.delete(queryLayersCache.keys().next().value!)
		}
	} else {
		// refresh the entry's insertion-order position so hot queries survive eviction
		queryLayersCache.delete(key)
		queryLayersCache.set(key, packet$)
	}
	return packet$
}

export function prefetchLayersQuery(input: LQY.LayersQueryInput) {
	void queryLayers$(input)
}

export function getQueryLayersInput(baseInput: LQY.BaseQueryInput, _opts?: QueryLayersInputOpts): LQY.LayersQueryInput {
	const opts: QueryLayersInputOpts = _opts ?? {}
	let sort = opts.sort ?? opts.cfg?.defaultSortBy ?? LQY.DEFAULT_SORT
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
				...(baseInput.constraints?.filter(c => !c.filterApplState) ?? []),
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

export async function generateVote(input: LQY.GenVote.Input) {
	const res = await sendWorkerRequest('genVote', input)
	if (res.code !== 'ok') return res
	const choiceRowData = res.chosenLayers.map(l => l ? layerToRowData(l, false, input.constraints ?? []) : undefined)
	return {
		...res,
		chosenLayers: choiceRowData,
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

const emptySettings = SETTINGS.PublicServerSettingsSchema.parse({})

// squadServerFrameKey is optional so this can be used from contexts with no active squad-server (e.g. the filter editor)
export function useLayerItemStatusConstraints(squadServerFrameKey?: SquadServerFrame.Key) {
	return ZusUtils.useStore(
		squadServerFrameKey ?? null,
		ZusUtils.useDeep(
			React.useCallback(
				(state: SquadServerFrame.State | undefined) => SETTINGS.getSettingsConstraints(state?.settings.saved ?? emptySettings),
				[],
			),
		),
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
	squadServerFrameKey?: SquadServerFrame.Key,
): LayerItemStatusData | null {
	const queriedConstraints = useLayerItemStatusConstraints(squadServerFrameKey)
	const statuses = ZusUtils.useStore(squadServerFrameKey, s => s?.layerItemStatuses)
	const itemId = LQY.resolveId(layerItem)

	const allMatchDescriptors = statuses?.matchDescriptors
	const presentLayers = statuses?.present

	const highlightedMatchDescriptors = ZusUtils.useStore(
		Store,
		ZusUtils.useDeep(React.useCallback((store) => {
			if (!allMatchDescriptors) return
			const hoveredConstraintItemId = store.hoveredConstraintItemId ?? undefined
			const hoveredMatchDescriptors = hoveredConstraintItemId && hoveredConstraintItemId !== itemId
					&& filterAndReportInvalidDescriptors(
						queriedConstraints,
						allMatchDescriptors.get(hoveredConstraintItemId)?.filter(vd => vd.type === 'repeat-rule' && vd.sourceItemId === itemId),
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

// resolved reactively into the squad-server frame's layerItemStatuses state; not a query
export async function fetchLayerItemStatuses(input: LQY.LayerItemStatusesInput): Promise<LQY.LayerItemStatuses | null> {
	const res = await sendWorkerRequest('getLayerItemStatuses', input)
	if (res.code === 'err:invalid-node') {
		console.error('getLayerItemStatuses: Invalid node error:', res.errors)
		return null
	}
	if (res.code === 'err:missing-item-states') {
		console.error('getLayerItemStatuses: missing item states')
		return null
	}
	return res.statuses
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
			const res = await sendWorkerRequest('layerExists', input!)
			if (res.code === 'err:missing-item-states') throw new Error('err:missing-item-states')
			return res.results
		},
		staleTime: Infinity,
	})
}

export function useDepKey(input?: unknown) {
	const backgroundStateEpoch = ZusUtils.useStore(Store, ZusUtils.useShallow(s => s.filtersModifiedEpoch))
	return getDepKey(input, backgroundStateEpoch)
}

// maps each distinct layerItems array reference to a small id so query keys compare the list shallowly
// (by reference + parity) instead of stringifying ~100 layer items into every key on every render
const layerItemsKeyIds = new WeakMap<object, number>()
let layerItemsKeyIdCounter = 0
function listDepKey(list: LQY.LayerItemsState) {
	let id = layerItemsKeyIds.get(list.layerItems)
	if (id === undefined) {
		id = ++layerItemsKeyIdCounter
		layerItemsKeyIds.set(list.layerItems, id)
	}
	return { layerItemsRef: id, firstLayerItemParity: list.firstLayerItemParity }
}

// get context/input that may invalidate the query
function getDepKey(input: unknown, backgroundStateEpoch: number) {
	const list = (input as LQY.BaseQueryInput | undefined)?.list
	if (typeof input === 'object' && input !== null && list !== undefined) {
		input = { ...(input as LQY.BaseQueryInput), list: listDepKey(list) }
	}
	return {
		input,
		backgroundStateEpoch,
	}
}

/**
 * Static configuration for query priorities.
 * Lower numbers = higher priority (processed first).
 */
export const QUERY_PRIORITIES: Record<WorkerTypes.RequestInner['type'], number> = {
	'filter-update': 5,
	'init': 5,
	getLayerItemStatuses: 4,
	queryLayers: 3,
	genVote: 3,
	layerExists: 2,
	getLayerInfo: 2,
	queryLayerComponent: 1,
} as const

const seqIdCounter = Gen.counter()
function getSeqId() {
	return seqIdCounter.next().value
}

let worker!: Worker

async function sendWorkerRequest<T extends WorkerTypes.ToWorker['type']>(
	type: T,
	input: Extract<WorkerTypes.ToWorker, { type: T }>['input'],
	_priority?: number,
): Promise<Extract<WorkerTypes.FromWorker, { type: T }>['payload']> {
	if (type !== 'init') await ensureFullSetup()

	const seqId = getSeqId()

	// Get priority from configuration
	const priority = _priority ?? QUERY_PRIORITIES[type] ?? 0

	const message = { type, input, seqId, priority }

	worker.postMessage(message)

	const response$ = Rx.fromEvent(worker, 'message').pipe(Rx.concatMap((e: any) => {
		const response = e.data as WorkerTypes.FromWorker
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

	const message: WorkerTypes.ToWorker = {
		type: 'queryLayers',
		input,
		seqId,
		priority: QUERY_PRIORITIES.queryLayers,
	}

	worker.postMessage(message)

	const response$ = Rx.fromEvent(worker, 'message').pipe(
		Rx.concatMap((e: any) => {
			const response = e.data as WorkerTypes.FromWorker
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
	try {
		Store.getState().setStatus('initializing')
		setup$ = setup()
		await setup$
		Store.getState().setStatus('ready')
	} catch (error) {
		console.error('Error setting up layer queries:', error)
		const errorMessage = error instanceof Error ? error.message : String(error)
		Store.getState().setStatus('error', errorMessage)
		throw error
	}
}

async function setup() {
	worker = new LQWorker({ name: 'layer-queries-worker' })

	const config = await ConfigClient.fetchConfig()

	const filters = await Rx.firstValueFrom(FilterEntityClient.initializedFilterEntities$())

	const ctx: WorkerTypes.InitRequest['input'] = {
		...CS.init(),
		effectiveColsConfig: LC.getEffectiveColumnConfig(config.extraColumnsConfig),
		filters,
	}

	// set downloading-layers status when the worker signals that it has started a download
	Rx.fromEvent(worker, 'message').pipe(
		Rx.map((event: any) => event.data as WorkerTypes.FromWorker),
		Rx.tap((message) => {
			if (message.type !== 'layer-download-started') return
			const store = Store.getState()
			if (store.status !== 'initializing') return
			store.setStatus('downloading-layers')
		}),
		Rx.takeWhile(msg => msg.type !== 'init'),
	).subscribe()

	const initPromise = sendWorkerRequest('init', ctx)
	// the follwing depends on the initPromise messages already having been sent during workerPool.initialize, otherwise we may send context-updates before initialization

	FilterEntityClient.filterEntities$.pipe(Rx.observeOn(Rx.asyncScheduler)).subscribe((filters) => {
		void sendWorkerRequest('filter-update', filters)
		Store.getState().incrementFiltersModifiedEpoch()
	})

	await initPromise
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
