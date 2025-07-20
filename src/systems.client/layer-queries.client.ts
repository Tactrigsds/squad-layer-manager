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
import * as Im from 'immer'
import * as Rx from 'rxjs'
import * as Zus from 'zustand'

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
			set({ counters: { ...get().counters, [key]: get().counters[key]++ } })
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

export function useLayerComponents(input: LQY.LayerComponentsInput, options?: { enabled?: boolean }) {
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
		...options,
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
		enabled: !!options.enabled,
		placeholderData: options?.usePlaceholderData ? (d) => d : undefined,
		queryKey: ['layers', 'layerExists', useDepKey(input)],
		queryFn: async () => {
			return await sendQuery('layerExists', input!)
		},
		staleTime: Infinity,
	})
}

export function useDepKey(input?: unknown) {
	const ctxModified = Zus.useStore(layerCtxVersionStore, s => s.counters)
	return getDepKey(input, ctxModified)
}

// get context/input that may invalidate the query
function getDepKey(input: unknown, ctxModified: LayerCtxModifiedCounters) {
	return {
		input,
		ctxModified,
	}
}

let lqWorker!: Worker
let nextSeqId = 1
const out$ = new Rx.Subject<WorkerTypes.QueryResponse>()

async function sendQuery<T extends WorkerTypes.QueryType>(type: T, input: WorkerTypes.QueryRequest<T>['input']) {
	await ensureSetup()
	const seqId = nextSeqId
	nextSeqId++
	const msg: WorkerTypes.QueryRequest<T> = { type, input, seqId: seqId }
	lqWorker.postMessage(msg)
	const res = await Rx.firstValueFrom(out$.pipe(Rx.filter(m => m.seqId === seqId)))
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
	lqWorker = new LQWorker()
	lqWorker.onmessage = async (event) => {
		out$.next(event.data)
	}
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
		const msg: WorkerTypes.ContextUpdateRequest = {
			type: 'context-update',
			ctx,
			seqId: nextSeqId++,
		}
		lqWorker.postMessage(msg)
		layerCtxVersionStore.getState().increment(ctx)
	})
	const ctx: WorkerTypes.InitRequest['ctx'] = {
		effectiveColsConfig: LC.getEffectiveColumnConfig(config.extraColumnsConfig),
		filters,
		layerItemsState: itemsState,
	}

	const msg: WorkerTypes.InitRequest = {
		type: 'init',
		seqId: 0,
		ctx,
	}
	lqWorker.postMessage(msg)
	await Rx.firstValueFrom(out$.pipe(Rx.filter(m => m.seqId === 0)))
}
