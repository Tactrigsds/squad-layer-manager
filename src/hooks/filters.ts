import { trpc } from '@/lib/trpc.client'
import * as M from '@/models.ts'
import type { WatchFilterOutput } from '@/server/systems/filters-entity'
import { state } from '@react-rxjs/core'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as Rx from 'rxjs'

export function useFilters(opts?: { enabled?: boolean; parts?: 'users'[] }) {
	return useQuery({
		queryKey: ['getFilters'],
		queryFn: () => trpc.filters.getFilters.query({ parts: opts?.parts }),
		enabled: opts?.enabled,
	})
}
export function useFilter(filterId: string | undefined) {
	const filtersRes = useFilters({ enabled: !!filterId })

	return {
		...filtersRes,
		data: filtersRes.data?.filters.find((f) => f.id === filterId),
	}
}

export function getFilterContributorQueryKey(filterId: string) {
	return ['getFilterContributors', filterId]
}

export function useFilterContributors(filterId: string) {
	return useQuery({
		queryKey: getFilterContributorQueryKey(filterId),
		queryFn: () => trpc.filters.getFilterContributors.query(filterId),
	})
}

export const filterUpdate$ = state((filterId: string) => {
	return new Rx.Observable<WatchFilterOutput>((s) => {
		const sub = trpc.filters.watchFilter.subscribe(filterId, {
			onData: (output) => {
				s.next(output)
			},
			onComplete: () => s.complete(),
			onError: (e) => s.error(e),
		})
		return () => sub.unsubscribe()
	}).pipe(Rx.share())
})

export const getFilterMutation$ = state((filterId: string) => {
	if (!filterId) return Rx.of(null)
	return filterUpdate$(filterId).pipe(
		Rx.filter((output): output is Extract<WatchFilterOutput, { code: 'mutation' }> => output?.code === 'mutation'),
		Rx.map((output) => output.mutation),
	)
})

export const getFilterEntity$ = state((filterId: string) => {
	return filterUpdate$(filterId).pipe(
		Rx.map((output): M.FilterEntity | null => {
			if (!output) return null
			if (output.code === 'mutation') {
				if (output.mutation.type === 'delete') return null
				return output.mutation.value
			}
			if (output.code === 'initial-value') {
				return output.entity
			}
			return null
		}),
		Rx.filter((v): v is M.FilterEntity => v !== undefined),
	)
})

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
