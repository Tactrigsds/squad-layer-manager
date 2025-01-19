import { trpc } from '@/lib/trpc.client'
import * as M from '@/models.ts'
import { useMutation, useQuery } from '@tanstack/react-query'

export function useFilters() {
	return useQuery({
		queryKey: ['getFilters'],
		queryFn: () => trpc.filters.getFilters.query(),
	})
}

export function useFilter(filterId?: string) {
	const filtersRes = useFilters()

	return { ...filtersRes, data: filtersRes.data?.find((f) => f.id === filterId) }
}

export function useFilterCreate() {
	return useMutation({
		mutationFn: trpc.filters.createFilter.mutate,
	})
}

export function useFilterUpdate() {
	return useMutation({
		mutationFn: trpc.filters.updateFilter.mutate,
	})
}

export function useFilterDelete() {
	return useMutation({
		mutationFn: trpc.filters.deleteFilter.mutate,
	})
}
