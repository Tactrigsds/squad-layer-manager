import * as AR from '@/app-routes'
import { globalToast$ } from '@/hooks/use-global-toast'
import * as Obj from '@/lib/object'
import * as ZusUtils from '@/lib/zustand'
import * as FB from '@/models/filter-builders'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import * as ConfigClient from '@/systems.client/config.client'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import * as WorkerTypes from '@/systems.client/layer-queries.worker'
import LQWorker from '@/systems.client/layer-queries.worker?worker'
import * as PartsSys from '@/systems.client/parts'
import * as QD from '@/systems.client/queue-dashboard'
import { reactQueryClient } from '@/trpc.client'
import { useQuery } from '@tanstack/react-query'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'
import { useShallow } from 'zustand/react/shallow'

type LayerCtxModifiedCounters = { [k in keyof WorkerTypes.DynamicQueryCtx]: number }

type LayerCtxModifiedState = {
	counters: LayerCtxModifiedCounters
	increment: (ctx: Partial<WorkerTypes.DynamicQueryCtx>) => void
}

// we don't want to use the entire query context as query state so instead we just increment these counters whenever one of them change and depend on that instead
const layerCtxVersionStore = Zus.createStore<LayerCtxModifiedState>((set, get) => ({
	counters: {
		filters: 0,
		layerItemsState: 0,
	},
	increment(ctx) {
		for (const key of Obj.objKeys(ctx)) {
			set({ counters: { ...get().counters, [key]: get().counters[key] + 1 } })
		}
	},
}))

export function useLayersQuery(input: LQY.LayersQueryInput, options?: { enabled?: boolean }) {
	options = options ? { ...options } : {}
	options.enabled = options.enabled ?? true
	return useQuery({
		...options,
		queryKey: ['layers', 'queryLayers', useDepKey(input)],
		placeholderData: (prev) => prev,
		enabled: options.enabled,
		queryFn: async () => {
			const res = await sendQuery('queryLayers', input)
			return res
		},
		staleTime: Infinity,
	})
}
export async function invalidateLayersQuery(input: LQY.LayersQueryInput) {
	return reactQueryClient.invalidateQueries({
		queryKey: ['layers', 'queryLayers', getDepKey(input, layerCtxVersionStore.getState().counters)],
	})
}

export async function prefetchLayersQuery(input: LQY.LayersQueryInput) {
	return reactQueryClient.prefetchQuery({
		queryKey: ['layers', 'queryLayers', getDepKey({ ...input }, layerCtxVersionStore.getState().counters)],
		queryFn: async () => sendQuery('queryLayers', input, 0),
		staleTime: Infinity,
	})
}

export function getLayerQueryInput(queryContext: LQY.LayerQueryBaseInput, opts?: {
	selectedLayers?: L.LayerId[]
	sort?: LQY.LayersQueryInput['sort']
	pageSize?: number
	pageIndex?: number
}): LQY.LayersQueryInput {
	const sort = opts?.sort ?? LQY.DEFAULT_SORT
	const pageSize = opts?.pageSize ?? LQY.DEFAULT_PAGE_SIZE
	const pageIndex = opts?.pageIndex
	const selectedLayers = opts?.selectedLayers

	if (selectedLayers) {
		const filter = FB.comp(FB.inValues('id', selectedLayers))
		queryContext = {
			...queryContext,
			constraints: [
				...(queryContext.constraints?.filter(c => c.applyAs === 'field') ?? []),
				{ type: 'filter-anon', id: 'show-selected', filter, applyAs: 'where-condition' },
			],
		}
	}

	return {
		...queryContext,
		pageIndex,
		sort,
		pageSize,
	}
}

export function useLayerComponents(input: LQY.LayerComponentInput, options?: { enabled?: boolean }) {
	options ??= {}
	return useQuery({
		...options,
		queryKey: ['layers', 'queryLayerComponents', useDepKey(input)],
		enabled: options?.enabled,
		queryFn: async () => sendQuery('queryLayerComponent', input),
		staleTime: Infinity,
	})
}
export function useSearchIds(input: LQY.SearchIdsInput, options?: { enabled?: boolean }) {
	options ??= {}
	return useQuery({
		queryKey: ['layers', 'searchIds', useDepKey(input)],
		enabled: options.enabled,
		queryFn: async () => await sendQuery('searchIds', input),
		staleTime: Infinity,
	})
}

export function useLayerItemStatuses(
	options?: { enabled?: boolean; addedInput?: LQY.LayerQueryBaseInput },
) {
	options ??= {}
	const input: LQY.LayerItemStatusesInput = {
		constraints: ZusUtils.useStoreDeep(QD.QDStore, QD.selectBaseQueryConstraints, { dependencies: [] }),
		numHistoryEntriesToResolve: 10,
		...(options.addedInput ?? {}),
	}
	const isEditing = QD.QDStore.getState().isEditing
	return useQuery({
		...options,
		queryKey: [
			'layers',
			'getLayerStatusesForLayerQueue',
			useDepKey({ ...input, isEditing }),
		],
		enabled: options?.enabled,
		queryFn: async () => {
			if (!QD.QDStore.getState().isEditing) {
				return PartsSys.getServerLayerItemStatuses()
			}
			const res = await sendQuery('getLayerItemStatuses', input)
			if (!res) return
			if (res.code !== 'ok') {
				globalToast$.next({ variant: 'destructive', description: res.msg, title: res.code })
				throw new Error(res.msg)
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
	const ctxCounters = Zus.useStore(layerCtxVersionStore, useShallow(s => s.counters))
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
	searchIds: 0,
	getLayerItemStatuses: 1,
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
			this.dispose()
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
		const t1 = performance.now()
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

		const t2 = performance.now()
		console.log(`processQueue took ${t2 - t1} ms`)
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
	await ensureSetup()

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
		throw new Error(errorMessage)
	}
}

let setup$: Promise<void> | null = null
export async function ensureSetup() {
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
function setupWindowFocusHandlers() {
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
				workerPool.dispose()
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

	const config = await ConfigClient.fetchConfig()

	const filters = await Rx.firstValueFrom(FilterEntityClient.initializedFilterEntities$())
	const itemsState = await Rx.firstValueFrom(QD.layerItemsState$)

	const dbBuffer = await fetchDatabaseBuffer()
	console.debug(`Using SharedArrayBuffer for database: ${dbBuffer.byteLength} bytes`)

	const ctx: WorkerTypes.InitRequest['ctx'] = {
		effectiveColsConfig: LC.getEffectiveColumnConfig(config.extraColumnsConfig),
		filters,
		layerItemsState: itemsState,
	}

	const initPromise = workerPool.initialize(dbBuffer, ctx)
	// the follwing depends on the initPromise messages already having been sent during workerPool.initialize, otherwise we may send context-updates before initialization
	const contextUpdate$ = new Rx.Subject<Partial<WorkerTypes.DynamicQueryCtx>>()
	FilterEntityClient.initializedFilterEntities$().subscribe(filters => {
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
		layerCtxVersionStore.getState().increment(ctx)
	})
	await initPromise
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

	// Convert ArrayBuffer to SharedArrayBuffer to minimize cloning overhead
	// This ensures workers can access the database without cloning the entire buffer
	console.debug(`Converting ${buffer.byteLength} byte database buffer to SharedArrayBuffer`)
	const sharedBuffer = new SharedArrayBuffer(buffer.byteLength)
	const sharedView = new Uint8Array(sharedBuffer)
	const bufferView = new Uint8Array(buffer)
	sharedView.set(bufferView)

	console.debug(`Created SharedArrayBuffer from database: ${sharedBuffer.byteLength} bytes - workers will now access shared memory`)
	return sharedBuffer
}
