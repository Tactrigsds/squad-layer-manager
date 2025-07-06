import * as LC from '@/models/layer-columns'
import * as LQY from '@/models/layer-queries.models'
import { reactQueryClient, trpc } from '@/trpc.client'
import { useQuery } from '@tanstack/react-query'

const baseQuery = {
	queryKey: ['config'],
	queryFn: () => {
		return trpc.config.query()
	},
}

export function useConfig() {
	return useQuery({
		...baseQuery,
		staleTime: Infinity,
	}).data
}

export function fetchConfig() {
	return reactQueryClient.getQueryCache().build(reactQueryClient, {
		...baseQuery,
	}).fetch()
}

export function setup() {
	reactQueryClient.prefetchQuery({ ...baseQuery })
}

export function invalidateConfig() {
	return reactQueryClient.invalidateQueries({ ...baseQuery })
}

export function useEffectiveColConfig(): LQY.EffectiveColumnAndTableConfig | undefined {
	const config = useConfig()
	if (!config) return

	return {
		...LC.getEffectiveColumnConfig(config.extraColumnsConfig),
		...config.layerTable,
	}
}
