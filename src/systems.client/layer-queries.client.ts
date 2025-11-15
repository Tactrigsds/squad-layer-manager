import * as AR from '@/app-routes'
import { globalToast$ } from '@/hooks/use-global-toast'
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

// oxlint-disable-next-line import/default
import LQWorker from '@/systems.client/layer-queries.worker?worker'
import * as QD from '@/systems.client/queue-dashboard'
import * as ServerSettingsClient from '@/systems.client/server-settings.client'
import * as UsersClient from '@/systems.client/users.client'
import { useQuery } from '@tanstack/react-query'
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
	setHoveredConstraintItemId(id: string | null): void
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

export function useQueryLayersOptions(input: LQY.LayersQueryInput, errorStore?: Zus.StoreApi<F.NodeValidationErrorStore>) {
	const counters = Zus.useStore(Store, s => s.counters)
	return getQueryLayersOptions(input, errorStore, counters)
}

function getIsLayerDisabled(layerData: RowData, canForceSelect: boolean, constraints: LQY.Constraint[]) {
	return !canForceSelect && layerData.constraints.values?.some((v, i) => !v && constraints[i].type !== 'do-not-repeat')
}

export type ConstraintRowDetails = {
	values: boolean[]
	violationDescriptors: LQY.MatchDescriptor[]
	matchedConstraints: LQY.Constraint[]
	matchedConstraintDescriptors: LQY.MatchDescriptor[]
}
export type RowData = L.KnownLayer & Record<string, any> & { 'constraints': ConstraintRowDetails; 'isRowDisabled': boolean }
/**
 * Convert a layer to RowData format with constraints and isRowDisabled computed
 */
function layerToRowData(
	layer: any,
	userCanForceSelect: boolean,
	queryConstraints: LQY.Constraint[],
): RowData {
	const constraintValues = Array.isArray(layer.constraints)
		? layer.constraints
		: layer.constraints?.values ?? []

	const violationDescriptors = Array.isArray(layer.violationDescriptors)
		? layer.violationDescriptors
		: layer.violationDescriptors ?? []

	const matchedConstraints = queryConstraints.filter((c: LQY.Constraint, i: number) => constraintValues[i])
	const matchedConstraintDescriptors = violationDescriptors

	const constraints: ConstraintRowDetails = {
		values: constraintValues,
		violationDescriptors,
		matchedConstraints,
		matchedConstraintDescriptors,
	}

	const isRowDisabled = !userCanForceSelect && getIsLayerDisabled({ ...layer, constraints }, userCanForceSelect, queryConstraints)

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

export function getQueryLayersOptions(
	input: LQY.LayersQueryInput,
	errorStore?: Zus.StoreApi<F.NodeValidationErrorStore>,
	counters?: LayerCtxModifiedCounters,
) {
	counters = counters ?? Store.getState().counters
	return {
		queryKey: ['layers', '__queryLayers__', getDepKey(input, counters)],
		queryFn: async () => {
			if (input.sort?.type === 'random' && !input.sort.seed) {
				throw new Error('Random sort requires a random seed when used with react query')
			}
			const res = await sendQuery('queryLayers', input)
			if (res?.code === 'err:invalid-node') {
				console.error('queryLayers: Invalid node error:', res.errors)
				errorStore?.setState({ errors: res.errors })
				throw new Error('Invalid node')
			} else {
				errorStore?.setState({ errors: undefined })
			}
			if (res?.code !== 'ok') return res

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
						violationDescriptors: [],
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
				return {
					...page,
					layers: page.layers?.map((layer: any) => layerToRowData(layer, userCanForceSelect, input.constraints ?? [])),
				}
			} else {
				return undefined
			}
		},
		staleTime: Infinity,
	}
}

export async function prefetchLayersQuery(baseInput: LQY.BaseQueryInput, errorStore?: Zus.StoreApi<F.NodeValidationErrorStore>) {
	const cfg = await ConfigClient.fetchEffectiveColConfig()
	const input = getQueryLayersInput(baseInput, { cfg })
	const baseQuery = getQueryLayersOptions(input, errorStore, Store.getState().counters)
	return await RPC.queryClient.prefetchQuery(
		baseQuery,
	)
}

export function getQueryLayersInput(queryContext: LQY.BaseQueryInput, opts: {
	cfg?: LQY.EffectiveColumnAndTableConfig
	selectedLayers?: L.LayerId[]
	sort?: LQY.LayersQueryInput['sort']
	pageSize?: number
	pageIndex?: number
}): LQY.LayersQueryInput {
	const sort = opts?.sort ?? opts.cfg?.defaultSortBy ?? LQY.DEFAULT_SORT
	const pageSize = opts.pageSize ?? LQY.DEFAULT_PAGE_SIZE
	const pageIndex = opts.pageIndex ?? 0
	const selectedLayers = opts.selectedLayers
	if (queryContext.cursor && !queryContext.action) {
		queryContext = { ...queryContext, action: 'add' }
	}

	if (selectedLayers) {
		const filter = FB.comp(
			FB.inValues('id', selectedLayers.filter(layer => LC.isKnownAndValidLayer(layer, opts.cfg))),
		)
		queryContext = {
			...queryContext,
			constraints: [
				...(queryContext.constraints?.filter(c => !c.filterResults) ?? []),
				CB.filterAnon('show-selected', filter),
			],
		}
	}

	return {
		...queryContext,
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
			const res = await sendQuery('queryLayerComponent', input)
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

export function useLayerItemStatusDataForItem(
	layerItem: LQY.LayerItem | LQY.ItemId,
	options?: { enabled?: boolean; errorStore?: Zus.StoreApi<F.NodeValidationErrorStore> },
) {
	const allConstraints = useLayerItemStatusConstraints()
	const queryRes = useLayerItemStatuses(allConstraints, options)
	const itemId = LQY.resolveId(layerItem)
	layerItem = typeof layerItem === 'string' ? LQY.fromSerial(layerItem) : layerItem
	const hoveredConstraintItemId = Zus.useStore(Store, s => s.hoveredConstraintItemId ?? undefined)

	const allViolationDescriptors = queryRes.data?.matchDescriptors

	const hoveredMatchDescriptors = hoveredConstraintItemId && hoveredConstraintItemId !== itemId
			&& filterAndReportInvalidDescriptors(
				allConstraints,
				allViolationDescriptors?.get(hoveredConstraintItemId)?.filter(vd => vd.itemId === itemId),
			)
		|| undefined

	const localMatchDescriptors = hoveredConstraintItemId === itemId
			&& filterAndReportInvalidDescriptors(
				allConstraints,
				allViolationDescriptors?.get(itemId),
			)
		|| undefined

	const matchingDescriptors = filterAndReportInvalidDescriptors(
		allConstraints,
		queryRes.data?.matchDescriptors.get(itemId),
	) ?? []

	// we're much more confident that hovered descriptors are present

	const matchingConstraints = allConstraints.filter(c => matchingDescriptors.find(d => d.constraintId === c.id))

	return {
		present: queryRes.data?.present,
		matchingConstraints,
		matchingDescriptors,

		// descriptors for the current hovered layer item that are relevant to this item. either we're the hovered item, or we have matching constraints against the hovered item
		highlightedMatchDescriptors: localMatchDescriptors ?? hoveredMatchDescriptors,
	}
}

// TODO prefetching
export function useLayerItemStatuses(
	constraints: LQY.Constraint[],
	options?: { enabled?: boolean; errorStore?: Zus.StoreApi<F.NodeValidationErrorStore> },
) {
	options ??= {}
	const input: LQY.LayerItemStatusesInput = { constraints, numHistoryEntriesToResolve: 10 }
	return useQuery({
		...options,
		queryKey: [
			'layers',
			'getLayerStatusesForLayerQueue',
			useDepKey(input),
		],
		enabled: options?.enabled,
		queryFn: async () => {
			// const counters = layerCtxVersionStore.getState().counters
			// if the layer context changes we can't trust the parts anymore
			// const layerContextUnchanged = Object.values(counters).every(c => c === 0)
			// if (!QD.QDStore.getState().isEditing && layerContextUnchanged) {
			// 	return PartsSys.getServerLayerItemStatuses()
			// }
			const res = await sendQuery('getLayerItemStatuses', input)
			if (!res) throw new Error('Unknown error')
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
			return await sendQuery('layerExists', input!)
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
export const QUERY_PRIORITIES = {
	queryLayers: 1,
	layerExists: 2,
	queryLayerComponent: 3,
	getLayerItemStatuses: 1,
	getLayerInfo: 2,
} as const

type PendingQuery = {
	message: any
	priority: number
	resolve: (value: any) => void
	reject: (error: Error) => void
	seqId: number
}

/**
 * Configuration for window focus management
 */
const FOCUS_CONFIG = {
	// Delay before terminating workers when window loses focus (in milliseconds)
	BLUR_TERMINATION_DELAY: 5000,
} as const

/**
 * Determines the optimal number of workers based on browser's reported concurrency.
 * Uses navigator.hardwareConcurrency with a maximum limit of 5 workers.
 */
function getOptimalWorkerCount(): number {
	// TODO due to memory usage concerns we're just setting this to 2 for now -- seems to be fast enough anyway
	return 2
	// Get the number of logical processors available
	const hardwareConcurrency = navigator.hardwareConcurrency || 4 // fallback to 4 if not available

	// Strategy: Use a conservative approach to avoid overwhelming the system
	// - For 1-2 cores: Use 2 workers (minimum viable parallelism)
	// - For 3-4 cores: Use 2-3 workers (conservative for typical laptops)
	// - For 5+ cores: Use 3-5 workers (scale up for powerful machines)
	let optimalCount: number

	if (hardwareConcurrency <= 2) {
		optimalCount = 2 // Minimum for basic parallelism
	} else if (hardwareConcurrency <= 4) {
		optimalCount = Math.min(3, hardwareConcurrency - 1) // Leave one core for main thread
	} else {
		optimalCount = Math.min(5, Math.floor(hardwareConcurrency * 0.6)) // Use 60% of cores, max 5
	}

	console.log(
		`Hardware concurrency: ${hardwareConcurrency} cores, `
			+ `selected ${optimalCount} workers for optimal database query performance`,
	)

	return optimalCount
}

/**
 * WorkerPool manages a pool of Web Workers for layer queries with priority queue functionality
 */
class LayerQueryWorkerPool {
	private workers: Worker[] = []
	private readonly poolSize: number
	private initialized = false
	private initializing = false
	private queryCount = 0
	private workerUsageCount: number[] = []
	private pendingQueries: PendingQuery[] = []
	private availableWorkers: Worker[] = []
	private activeQueries = new Map<number, PendingQuery>()

	constructor(poolSize: number = getOptimalWorkerCount()) {
		this.poolSize = poolSize
	}

	async initialize(dbBuffer: SharedArrayBuffer, ctx: WorkerTypes.InitRequest['ctx']) {
		if (this.initialized) return
		if (this.initializing) {
			throw new Error('Worker pool is already initializing')
		}

		this.initializing = true

		try {
			// Create workers
			for (let i = 0; i < this.poolSize; i++) {
				const worker = new LQWorker()
				worker.onmessageerror = (event) => {
					console.error(`Worker ${i} message error:`, event)
				}
				worker.onmessage = (event) => {
					this.handleWorkerMessage(event, worker)
				}
				worker.onerror = (error) => {
					console.error(`Worker ${i} error:`, error)
					globalToast$.next({
						variant: 'destructive',
						description: `Worker ${i} encountered an error: ${error.message}`,
					})
				}
				this.workers.push(worker)
				this.availableWorkers.push(worker)
				this.workerUsageCount.push(0)
			}

			// Initialize all workers
			const initPromises = this.workers.map(async (worker, index) => {
				const msg: WorkerTypes.InitRequest = {
					type: 'init',
					seqId: -(index + 1), // Use negative seqIds for init to avoid conflicts
					ctx,
					dbBuffer,
				}
				worker.postMessage(msg)
				const response = await Rx.firstValueFrom(out$.pipe(Rx.filter(m => m.seqId === -(index + 1))))
				if (response.error) {
					throw new Error(`Worker ${index} initialization failed: ${response.error}`)
				}
			})

			await Promise.all(initPromises)
			this.initialized = true
			console.debug(`Worker pool initialized with ${this.poolSize} workers`)
		} catch (error) {
			void this.dispose()
			throw error
		} finally {
			this.initializing = false
		}
	}

	private handleWorkerMessage(event: MessageEvent, worker: Worker) {
		const response = event.data as WorkerTypes.QueryResponse

		// Handle query responses
		if (this.activeQueries.has(response.seqId)) {
			const query = this.activeQueries.get(response.seqId)!
			this.activeQueries.delete(response.seqId)

			// Make worker available again
			this.availableWorkers.push(worker)

			if (response.error) {
				query.reject(new Error(response.error))
			} else {
				query.resolve(response.payload)
			}

			// Process next query in queue
			this.processQueue()
		} else {
			// Forward other messages (like init responses) to the original observable
			out$.next(response)
		}
	}

	private processQueue() {
		while (this.availableWorkers.length > 0 && this.pendingQueries.length > 0) {
			// Sort by priority (lower number = higher priority)
			this.pendingQueries.sort((a, b) => a.priority - b.priority)

			const query = this.pendingQueries.shift()!
			const worker = this.availableWorkers.shift()!

			this.activeQueries.set(query.seqId, query)

			// Track worker usage
			const workerIndex = this.workers.indexOf(worker)
			this.workerUsageCount[workerIndex]++
			this.queryCount++

			worker.postMessage(query.message)
		}
	}

	postMessage(message: any, priority: number = 0): Promise<any> {
		if (!this.initialized) {
			return Promise.reject(
				new Error('Worker pool not initialized. This may happen when the window loses focus and workers are terminated to save memory.'),
			)
		}

		return new Promise((resolve, reject) => {
			const query: PendingQuery = {
				message,
				priority,
				resolve,
				reject,
				seqId: message.seqId,
			}

			this.pendingQueries.push(query)
			this.processQueue()
		})
	}

	updateContext(message: WorkerTypes.ContextUpdateRequest) {
		// Send context updates to all workers
		for (const worker of this.workers) {
			worker.postMessage(message)
		}
	}

	async dispose() {
		// Wait for all active queries to complete with a timeout
		const activeQueryPromises = Array.from(this.activeQueries.values()).map(query =>
			new Promise<void>((resolve) => {
				const originalResolve = query.resolve
				const originalReject = query.reject

				query.resolve = (value: any) => {
					originalResolve(value)
					resolve()
				}
				query.reject = (error: Error) => {
					originalReject(error)
					resolve()
				}
			})
		)

		// Set up timeout
		const timeoutPromise = new Promise<void>((resolve) => {
			setTimeout(() => {
				console.warn('Worker pool disposal timeout reached, forcing termination')
				resolve()
			}, 30000) // 30 seconds
		})

		// Wait for either all queries to complete or timeout
		if (activeQueryPromises.length > 0) {
			console.debug(`Waiting for ${activeQueryPromises.length} active queries to complete before disposing worker pool...`)
			await Promise.race([
				Promise.all(activeQueryPromises),
				timeoutPromise,
			])
		}

		// Reject all remaining pending queries
		for (const query of this.pendingQueries) {
			query.reject(new Error('Worker pool terminated'))
		}
		// Reject any remaining active queries (in case of timeout)
		for (const query of this.activeQueries.values()) {
			query.reject(new Error('Worker pool terminated'))
		}

		for (const worker of this.workers) {
			try {
				worker.terminate()
			} catch (error) {
				console.warn('Error terminating worker:', error)
			}
		}

		this.workers = []
		this.availableWorkers = []
		this.pendingQueries = []
		this.activeQueries.clear()
		this.initialized = false
		this.initializing = false
		this.queryCount = 0
		this.workerUsageCount = []
	}

	isInitialized(): boolean {
		return this.initialized
	}

	getStats() {
		return {
			poolSize: this.poolSize,
			initialized: this.initialized,
			totalQueries: this.queryCount,
			workerUsage: this.workerUsageCount.map((count, index) => ({
				workerId: index,
				queriesHandled: count,
			})),
			averageQueriesPerWorker: this.queryCount / this.poolSize,
			usingSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
		}
	}
}

let workerPool!: LayerQueryWorkerPool
let nextSeqId = 1
const out$ = new Rx.Subject<WorkerTypes.QueryResponse>()
let windowFocusCleanupFn: (() => void) | null = null

export async function sendQuery<T extends WorkerTypes.QueryType>(type: T, input: WorkerTypes.QueryRequest<T>['input'], priority?: number) {
	await ensureFullSetup()

	const seqId = nextSeqId
	nextSeqId++
	const msg: WorkerTypes.QueryRequest<T> = { type, input, seqId: seqId }

	// Get priority from configuration
	priority ??= QUERY_PRIORITIES[type] ?? 0

	try {
		const payload = await workerPool.postMessage(msg, priority)
		return payload as WorkerTypes.QueryResponse<T>['payload']
	} catch (error) {
		if (error instanceof Error) {
			globalToast$.next({ variant: 'destructive', description: error.message })
			throw error
		}
		const errorMessage = String(error)
		globalToast$.next({ variant: 'destructive', description: errorMessage })
		throw new Error(errorMessage, { cause: error })
	}
}

let setup$: Promise<void> | null = null
export async function ensureFullSetup() {
	if (setup$) return await setup$
	setup$ = setup()
	await setup$
}

/**
 * Sets up window focus and page visibility handlers to manage worker pool lifecycle.
 *
 * When the window loses focus or becomes hidden:
 * - Schedules worker termination after a delay to save memory
 *
 * When the window regains focus or becomes visible:
 * - Cancels scheduled termination
 * - Reinitializes workers if they were previously terminated
 * - Refetches the database buffer to ensure data freshness
 */
function _setupWindowFocusHandlers() {
	if (windowFocusCleanupFn) return // Already set up

	let blurTimeout: number | null = null

	const scheduleTermination = () => {
		// Clear any existing timeout
		if (blurTimeout) {
			clearTimeout(blurTimeout)
		}

		// Delay termination to avoid flickering when switching between browser windows/tabs quickly
		console.debug(`Window lost focus/visibility, will terminate worker pool in ${FOCUS_CONFIG.BLUR_TERMINATION_DELAY}ms to save memory`)
		blurTimeout = window.setTimeout(() => {
			if (workerPool && workerPool.isInitialized()) {
				console.debug('Terminating worker pool due to window losing focus/visibility')
				const stats = workerPool.getStats()
				console.log('Worker pool stats before focus termination:', stats)
				void workerPool.dispose()
			}
		}, FOCUS_CONFIG.BLUR_TERMINATION_DELAY)
	}

	const handleVisibilityChange = async () => {
		if (document.hidden) {
			scheduleTermination()
		} else {
			// Cancel pending termination if window regains focus quickly
			if (blurTimeout) {
				console.debug('Window regained focus, cancelling scheduled worker pool termination')
				clearTimeout(blurTimeout)
				blurTimeout = null
			}
		}
	}

	document.addEventListener('visibilitychange', handleVisibilityChange)

	windowFocusCleanupFn = () => {
		document.removeEventListener('visibilitychange', handleVisibilityChange)
		if (blurTimeout) {
			clearTimeout(blurTimeout)
			blurTimeout = null
		}
		windowFocusCleanupFn = null
	}

	// Store handlers for manual triggering (useful for testing)
	return {
		handleVisibilityChange,
		cleanup: windowFocusCleanupFn,
	}
}

async function setup() {
	workerPool = new LayerQueryWorkerPool()

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

	const dbBuffer = await fetchDatabaseBuffer()

	const ctx: WorkerTypes.InitRequest['ctx'] = {
		effectiveColsConfig: LC.getEffectiveColumnConfig(config.extraColumnsConfig),
		filters,
		layerItemsState: itemsState,
	}

	const initPromise = workerPool.initialize(dbBuffer, ctx)
	// the follwing depends on the initPromise messages already having been sent during workerPool.initialize, otherwise we may send context-updates before initialization
	const contextUpdate$ = new Rx.Subject<Partial<WorkerTypes.DynamicQueryCtx>>()
	FilterEntityClient.filterEntities$.subscribe(filters => {
		contextUpdate$.next({ filters })
	})

	QD.layerItemsState$.subscribe(itemsState => {
		contextUpdate$.next({ layerItemsState: itemsState })
	})

	contextUpdate$.subscribe(ctx => {
		const msg: WorkerTypes.ContextUpdateRequest = {
			type: 'context-update',
			ctx,
			seqId: nextSeqId++,
		}
		workerPool.updateContext(msg)
		Store.getState().increment(ctx)
	})
	await initPromise
	console.log('Layers loaded')
	// Set up window focus handlers after successful initialization
	// const focusHandlers = setupWindowFocusHandlers()
}

/**
 * Manually trigger window blur behavior (useful for testing or manual memory management)
 */
export function manuallyBlurWindow() {
	const event = new Event('blur')
	window.dispatchEvent(event)
}

/**
 * Manually trigger window focus behavior (useful for testing or manual reinitialization)
 */
export function manuallyFocusWindow() {
	const event = new Event('focus')
	window.dispatchEvent(event)
}

/**
 * Get current worker pool statistics
 */
export function getWorkerPoolStats() {
	return workerPool?.getStats() ?? null
}

/**
 * Check if the window is currently focused and visible
 */
export function isWindowFocused(): boolean {
	return document.hasFocus() && !document.hidden
}

/**
 * Check if the page is currently visible (not minimized or in background tab)
 */
export function isPageVisible(): boolean {
	return !document.hidden
}

export async function cleanupWorkerPool() {
	setup$ = null
	if (workerPool) {
		console.log('Worker pool stats before cleanup:', workerPool.getStats())
		await workerPool.dispose()
	}
	if (windowFocusCleanupFn) {
		windowFocusCleanupFn()
	}
}

async function fetchDatabaseBuffer(): Promise<SharedArrayBuffer> {
	useIsFetchingLayerData.setState(true)
	try {
		// Check if SharedArrayBuffer is available
		if (typeof SharedArrayBuffer === 'undefined') {
			throw new Error('SharedArrayBuffer is not available. This requires a secure context (HTTPS) and appropriate headers.')
		}

		const opfsRoot = await navigator.storage.getDirectory()
		const dbFileName = 'layers.sqlite3'
		const hashFileName = 'layers.sqlite3.hash'

		let dbHandle: FileSystemFileHandle
		let hashHandle: FileSystemFileHandle
		let storedHash: string | null = null

		try {
			const dbHandlePromise = opfsRoot.getFileHandle(dbFileName).then(handle => {
				return handle
			})
			const hashHandlePromise = opfsRoot.getFileHandle(hashFileName).then(handle => {
				return handle
			})
			const storedHashPromise = hashHandlePromise.then(hashHandle => hashHandle.getFile()).then(hashFile => hashFile.text()).then(text => {
				return text
			})
			;[dbHandle, hashHandle, storedHash] = await Promise.all([dbHandlePromise, hashHandlePromise, storedHashPromise])
		} catch {
			;[dbHandle, hashHandle] = await Promise.all([
				opfsRoot.getFileHandle(dbFileName, { create: true }),
				opfsRoot.getFileHandle(hashFileName, { create: true }),
			])
		}

		const headers = storedHash ? { 'If-None-Match': storedHash } : undefined

		const res = await fetch(AR.link('/layers.sqlite3'), { headers })

		let buffer: ArrayBuffer

		if (res.status === 304) {
			const cachedFile = await dbHandle.getFile()
			buffer = await cachedFile.arrayBuffer()
		} else {
			buffer = await res.arrayBuffer()

			// Store in OPFS
			const writable = await dbHandle.createWritable()
			await writable.write(buffer)
			await writable.close()

			// Store hash
			const etag = res.headers.get('ETag')
			if (etag) {
				const hashWritable = await hashHandle.createWritable()
				await hashWritable.write(etag)
				await hashWritable.close()
			}
		}

		// Convert to SharedArrayBuffer to minimize cloning overhead
		const sharedBuffer = new SharedArrayBuffer(buffer.byteLength)
		const sharedView = new Uint8Array(sharedBuffer)
		const bufferView = new Uint8Array(buffer)
		sharedView.set(bufferView)
		return sharedBuffer
	} finally {
		useIsFetchingLayerData.setState(false)
	}
}

export function getLayerInfoQueryOptions(layer: L.LayerId | L.KnownLayer) {
	const input = { layerId: typeof layer === 'string' ? layer : layer.id }
	return RPC.orpc.layerQueries.getLayerInfo.queryOptions({ input, staleTime: Infinity })
}

export function fetchLayerInfo(layer: L.LayerId | L.KnownLayer) {
	return RPC.queryClient.getQueryCache().build(RPC.queryClient, getLayerInfoQueryOptions(layer)).fetch()
}
