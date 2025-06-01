import { reactQueryClient, trpc } from '@/trpc.client'
import { useQuery } from '@tanstack/react-query'
const baseQuery = {
	queryKey: ['config'],
	queryFn: () => trpc.config.query(),
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
	return reactQueryClient.invalidateQueries(baseQuery.queryKey)
}
