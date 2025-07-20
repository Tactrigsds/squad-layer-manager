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
			return await sendQuery('queryLayers', input)
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
		queryKey: ['layers', 'queryLayers', getDepKey(input, layerCtxVersionStore.getState().counters)],
		queryFn: async () => sendQuery('queryLayers', input),
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
		queryFn: async () => sendQuery('queryLayerComponents', input),
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

export function useLayerStatuses(
	options?: { enabled?: boolean },
) {
	options ??= {}
	const input: LQY.LayerStatusesForLayerQueueInput = {
		constraints: ZusUtils.useStoreDeep(QD.QDStore, QD.selectBaseQueryConstraints),
		numHistoryEntriesToResolve: 10,
	}
	return useQuery({
		...options,
		queryKey: [
			'layers',
			'getLayerStatusesForLayerQueue',
			useDepKey(input),
		],
		enabled: options?.enabled,
		queryFn: async () => {
			const res = await sendQuery('getLayerStatusesForLayerQueue', input)
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
 * Determines the optimal number of workers based on browser's reported concurrency.
 * Uses navigator.hardwareConcurrency with a maximum limit of 5 workers.
 */
function getOptimalWorkerCount(): number {
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
 * WorkerPool manages a pool of Web Workers for layer queries
 */
class LayerQueryWorkerPool {
	private workers: Worker[] = []
	private nextWorkerIndex = 0
	private readonly poolSize: number
	private initialized = false
	private initializing = false
	private queryCount = 0
	private workerUsageCount: number[] = []

	constructor(poolSize: number = getOptimalWorkerCount()) {
		this.poolSize = poolSize
	}

	async initialize(dbBuffer: ArrayBuffer, ctx: WorkerTypes.InitRequest['ctx']) {
		if (this.initialized) return
		if (this.initializing) {
			throw new Error('Worker pool is already initializing')
		}

		this.initializing = true

		try {
			// Create workers
			for (let i = 0; i < this.poolSize; i++) {
				const worker = new LQWorker()
				worker.onmessage = (event) => {
					out$.next(event.data)
				}
				worker.onerror = (error) => {
					console.error(`Worker ${i} error:`, error)
					globalToast$.next({
						variant: 'destructive',
						description: `Worker ${i} encountered an error: ${error.message}`,
					})
				}
				this.workers.push(worker)
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
			console.log(`Worker pool initialized with ${this.poolSize} workers`)
		} catch (error) {
			// Clean up on failure
			this.terminate()
			throw error
		} finally {
			this.initializing = false
		}
	}

	getNextWorker(): Worker {
		if (!this.initialized) {
			throw new Error('Worker pool not initialized')
		}
		if (this.workers.length === 0) {
			throw new Error('No workers available in pool')
		}
		const worker = this.workers[this.nextWorkerIndex]
		this.workerUsageCount[this.nextWorkerIndex]++
		this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.poolSize
		return worker
	}

	postMessage(message: any) {
		const worker = this.getNextWorker()
		this.queryCount++
		worker.postMessage(message)
	}

	updateContext(message: WorkerTypes.ContextUpdateRequest) {
		// Send context updates to all workers
		for (const worker of this.workers) {
			worker.postMessage(message)
		}
	}

	terminate() {
		for (const worker of this.workers) {
			try {
				worker.terminate()
			} catch (error) {
				console.warn('Error terminating worker:', error)
			}
		}
		this.workers = []
		this.initialized = false
		this.initializing = false
		this.queryCount = 0
		this.workerUsageCount = []
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
		}
	}
}

let workerPool!: LayerQueryWorkerPool
let nextSeqId = 1
const out$ = new Rx.Subject<WorkerTypes.QueryResponse>()

async function sendQuery<T extends WorkerTypes.QueryType>(type: T, input: WorkerTypes.QueryRequest<T>['input']) {
	await ensureSetup()
	const seqId = nextSeqId
	nextSeqId++
	const msg: WorkerTypes.QueryRequest<T> = { type, input, seqId: seqId }
	workerPool.postMessage(msg)
	const res = await Rx.firstValueFrom(out$.pipe(Rx.filter(m => m.seqId === seqId))) as WorkerTypes.QueryResponse<T>
	if (res.error) {
		globalToast$.next({ variant: 'destructive', description: res.error })
		throw new Error(res.error)
	}
	return res.payload
}

let setup$: Promise<void> | null = null
export async function ensureSetup() {
	if (setup$) return await setup$
	setup$ = setup()
	await setup$
}

async function setup() {
	// Initialize worker pool with optimal number of workers based on browser concurrency
	// This allows for concurrent database queries while respecting hardware limitations
	workerPool = new LayerQueryWorkerPool()

	const config = await ConfigClient.fetchConfig()

	const filters = await Rx.firstValueFrom(FilterEntityClient.initializedFilterEntities$())
	const itemsState = await Rx.firstValueFrom(QD.layerItemsState$)

	const contextUpdate$ = new Rx.Subject<Partial<WorkerTypes.DynamicQueryCtx>>()
	FilterEntityClient.initializedFilterEntities$().subscribe(filters => {
		contextUpdate$.next({ filters })
	})

	QD.layerItemsState$.subscribe(itemsState => {
		contextUpdate$.next({ layerItemsState: itemsState })
	})

	contextUpdate$.subscribe(ctx => {
		console.log('context update', ctx)
		const msg: WorkerTypes.ContextUpdateRequest = {
			type: 'context-update',
			ctx,
			seqId: nextSeqId++,
		}
		workerPool.updateContext(msg)
		layerCtxVersionStore.getState().increment(ctx)
	})

	// Fetch database buffer in main thread
	const dbBuffer = await fetchDatabaseBuffer()

	const ctx: WorkerTypes.InitRequest['ctx'] = {
		effectiveColsConfig: LC.getEffectiveColumnConfig(config.extraColumnsConfig),
		filters,
		layerItemsState: itemsState,
	}

	await workerPool.initialize(dbBuffer, ctx)
}

export function cleanupWorkerPool() {
	if (workerPool) {
		console.log('Worker pool stats before cleanup:', workerPool.getStats())
		workerPool.terminate()
	}
	setup$ = null
}

async function fetchDatabaseBuffer(): Promise<ArrayBuffer> {
	const opfsRoot = await navigator.storage.getDirectory()
	const dbFileName = 'layers.sqlite3'
	const hashFileName = 'layers.sqlite3.hash'

	let dbHandle: FileSystemFileHandle
	let hashHandle: FileSystemFileHandle
	let storedHash: string | null = null

	try {
		const dbHandlePromise = opfsRoot.getFileHandle(dbFileName)
		const hashHandlePromise = opfsRoot.getFileHandle(hashFileName)
		const storedHashPromise = hashHandlePromise.then(hashHandle => hashHandle.getFile()).then(hashFile => hashFile.text())
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

	return buffer
}
