import { globalToast$ } from '@/hooks/use-global-toast'
import * as CS from '@/models/context-shared'
import * as FB from '@/models/filter-builders'
import * as L from '@/models/layer'
import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import { baseLogger } from '@/server/systems/logger.client'
import * as ConfigClient from '@/systems.client/config.client'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import * as LayerDbClient from '@/systems.client/layer-db.client'
import * as MatchHistoryClient from '@/systems.client/match-history.client'
import * as QD from '@/systems.client/queue-dashboard'
import * as LayerQueries from '@/systems.shared/layer-queries.shared'
import { reactQueryClient } from '@/trpc.client'
import { useQuery } from '@tanstack/react-query'
import superjson from 'superjson'
import * as Zus from 'zustand'

export function useLayersQuery(input: LQY.LayersQueryInput, options?: { enabled?: boolean }) {
	options ??= {}
	const args = useArgs(input)
	return useQuery({
		...options,
		queryKey: ['layers', 'queryLayers', getDepKey(args)],
		placeholderData: (prev) => prev,
		enabled: !!args,
		queryFn: async () => LayerQueries.queryLayers(args!),
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
		queryFn: async () => LayerQueries.queryLayers(args),
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
		previousLayerIds: queryContext.previousLayerIds ?? [],
		constraints: queryContext.constraints ?? [],
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
		queryFn: async () => LayerQueries.queryLayerComponents(args!),
		staleTime: Infinity,
	})
}
export function useSearchIds(input: LayerQueries.SearchIdsInput, options?: { enabled?: boolean }) {
	options ??= {}
	const args = useArgs(input)
	return useQuery({
		...options,
		queryKey: ['layers', 'queryIds', getDepKey(args)],
		enabled: !!args,
		queryFn: async () => LayerQueries.searchIds(args!),
		staleTime: Infinity,
	})
}

export function useLayerStatuses(
	options?: { enabled?: boolean },
) {
	options ??= {}
	const editedQueue = Zus.useStore(QD.QDStore, s => s.editedServerState.layerQueue)
	const editedPool = Zus.useStore(QD.QDStore, s => s.editedServerState.settings.queue.mainPool)
	const args = useArgs({ queue: editedQueue, pool: editedPool })
	return useQuery({
		...options,
		queryKey: [
			'layers',
			'getLayerStatusesForLayerQueue',
			getDepKey(args),
		],
		enabled: !!args,
		queryFn: async () => {
			const res = await LayerQueries.getLayerStatusesForLayerQueue(args!)
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
	input: LayerQueries.LayerExistsInput,
	options?: { enabled?: boolean; usePlaceholderData?: boolean },
) {
	options ??= {}
	const args = useArgs(input)
	return useQuery({
		...options,
		placeholderData: options?.usePlaceholderData ? (d) => d : undefined,
		queryKey: ['layers', 'layerExists', getDepKey(args)],
		enabled: !!args,
		queryFn: async () => {
			return await LayerQueries.layerExists(args!)
		},
		staleTime: Infinity,
	})
}

// get context/input that may invalidate the query
function getDepKey<I>(args?: { ctx: CS.LayerQuery; input: I }) {
	if (!args) return
	return superjson.serialize({
		recentMatches: args.ctx.recentMatches,
		filters: args.ctx.filters,
		input: args.input,
	})
}

export async function fetchArgs<T>(input: T): Promise<{ ctx: CS.LayerQuery; input: T }> {
	const recentMatches = MatchHistoryClient.recentMatches$.getValue()
	const filters = Array.from(FilterEntityClient.filterEntities$.getValue().values())
	const config = await ConfigClient.fetchConfig()

	const layerDb = await LayerDbClient.fetchLayerDb()
	return {
		ctx: {
			layerDb: () => layerDb,
			recentMatches,
			effectiveColsConfig: LC.getEffectiveColumnConfig(config.extraColumnsConfig),
			filters,
			log: baseLogger,
		},
		input,
	}
}

function useArgs<T>(input: T): { ctx: CS.LayerQuery; input: T } | undefined {
	const recentMatches = MatchHistoryClient.useRecentMatches()
	const effectiveColsConfig = ConfigClient.useEffectiveColConfig()
	const filters = Array.from(FilterEntityClient.useFilterEntities().values())
	const layerDb = LayerDbClient.useLayerDb()
	if (!effectiveColsConfig) return
	if (!layerDb) return
	return {
		input,
		ctx: {
			layerDb: () => layerDb,
			recentMatches,
			effectiveColsConfig,
			filters,
			log: baseLogger,
		},
	}
}
