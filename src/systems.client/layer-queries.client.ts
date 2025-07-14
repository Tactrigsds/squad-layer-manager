import { globalToast$ } from '@/hooks/use-global-toast'
import * as FB from '@/models/filter-builders'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import * as ConfigClient from '@/systems.client/config.client'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import type * as WorkerTypes from '@/systems.client/layer-queries.worker'
import LQWorker from '@/systems.client/layer-queries.worker?worker'
import * as QD from '@/systems.client/queue-dashboard'
import { reactQueryClient } from '@/trpc.client'
import { useQuery } from '@tanstack/react-query'
import * as Rx from 'rxjs'
import superjson from 'superjson'

let lqWorker!: Worker

export function useLayersQuery(input: LQY.LayersQueryInput, options?: { enabled?: boolean }) {
	options = options ? { ...options } : {}
	options.enabled = options.enabled ?? true
	const args = useArgs(input)
	return useQuery({
		...options,
		queryKey: ['layers', 'queryLayers', getDepKey(args)],
		placeholderData: (prev) => prev,
		enabled: !!args && options.enabled,
		queryFn: async () => {
			return await send('queryLayers', args!)
		},
		staleTime: Infinity,
	})
}
export async function invalidateLayersQuery(input: LQY.LayersQueryInput) {
	const args = await fetchArgs(input)
	return reactQueryClient.invalidateQueries({ queryKey: ['layers', 'queryLayers', getDepKey(args)] })
}

export async function prefetchLayersQuery(input: LQY.LayersQueryInput) {
	const args = await fetchArgs(input)
	return reactQueryClient.prefetchQuery({
		queryKey: ['layers', 'queryLayers', getDepKey(args)],
		queryFn: async () => send('queryLayers', args),
		staleTime: Infinity,
	})
}

export function getLayerQueryInput(queryContext: LQY.LayerQueryContext, opts?: {
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
	const args = useArgs(input)
	return useQuery({
		...options,
		queryKey: ['layers', 'queryLayerComponents', getDepKey(args)],
		enabled: !!args,
		queryFn: async () => send('queryLayerComponents', args!),
		staleTime: Infinity,
	})
}
export function useSearchIds(input: LQY.SearchIdsInput, options?: { enabled?: boolean }) {
	options ??= {}
	const args = useArgs(input)
	return useQuery({
		...options,
		queryKey: ['layers', 'searchIds', getDepKey(args)],
		enabled: !!args,
		queryFn: async () => await send('searchIds', args!),
		staleTime: Infinity,
	})
}

export function useLayerStatuses(
	options?: { enabled?: boolean },
) {
	options ??= {}
	const args = useArgs({ ...QD.useFullLayerQueryContext() })
	return useQuery({
		...options,
		queryKey: [
			'layers',
			'getLayerStatusesForLayerQueue',
			getDepKey(args),
		],
		enabled: !!args,
		queryFn: async () => {
			const res = await send('getLayerStatusesForLayerQueue', args!)
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
	input: LQY.LayerExistsInput,
	options?: { enabled?: boolean; usePlaceholderData?: boolean },
) {
	options ??= {}
	const args = useArgs(input)
	return useQuery({
		enabled: !!options.enabled,
		placeholderData: options?.usePlaceholderData ? (d) => d : undefined,
		queryKey: ['layers', 'layerExists', getDepKey(args)],
		queryFn: async () => {
			return await send('layerExists', args!)
		},
		staleTime: Infinity,
	})
}

// get context/input that may invalidate the query
function getDepKey<I>(args?: { ctx: WorkerTypes.DynamicQueryCtx; input: I }) {
	if (!args) return
	return {
		...args,
		ctx: {
			...args.ctx,
			filters: args.ctx.filters.map(f => ({ ...f, owner: f.owner.toString() })),
		},
	}
}

export async function fetchArgs<T>(input: T): Promise<{ ctx: WorkerTypes.DynamicQueryCtx; input: T }> {
	const filters = await FilterEntityClient.resolveInitializedFilterEntities()
	return {
		ctx: {
			filters: Array.from(filters.values()),
		},
		input,
	}
}

function useArgs<T>(input: T): { ctx: WorkerTypes.DynamicQueryCtx; input: T } | undefined {
	const filters = FilterEntityClient.useInitializedFilterEntities()
	if (!filters) return
	return {
		input,
		ctx: {
			filters: Array.from(filters.values()),
		},
	}
}

let nextSeqId = 1
const out$ = new Rx.Subject<WorkerTypes.Outbound>()
async function send<T extends WorkerTypes.QueryType>(type: T, args: WorkerTypes.Incoming<T>['args']) {
	await ensureSetup()
	const seqId = nextSeqId
	nextSeqId++
	const msg = { type, args, seqId: seqId }
	lqWorker.postMessage(msg)
	return (await Rx.firstValueFrom(out$.pipe(Rx.filter(m => m.seqId === seqId)))).response as WorkerTypes.Outbound<T>['response']
}

let setup$: Promise<void> | null = null
export async function ensureSetup() {
	if (setup$) return await setup$
	setup$ = (async () => {
		lqWorker = new LQWorker()
		lqWorker.onmessage = async (event) => {
			out$.next(event.data)
		}
		const config = await ConfigClient.fetchConfig()
		const msg = {
			type: 'init',
			seqId: 0,
			args: { ...LC.getEffectiveColumnConfig(config.extraColumnsConfig), ...config.layerTable },
		}
		lqWorker.postMessage(msg)
		await Rx.firstValueFrom(out$.pipe(Rx.filter(m => m.seqId === 0)))
	})()
	return await setup$
}
