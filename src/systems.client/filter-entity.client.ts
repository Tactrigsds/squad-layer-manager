import { assertNever } from '@/lib/typeGuards'
import * as M from '@/models.ts'
import { type WatchFiltersOutput } from '@/server/systems/filter-entity'
import * as PartsSys from '@/systems.client/parts'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import { useMutation, useQuery } from '@tanstack/react-query'
import * as Rx from 'rxjs'

export function getFilterContributorQueryKey(filterId: string) {
	return ['getFilterContributors', filterId]
}

export function useFilterContributors(filterId: string) {
	return useQuery({
		queryKey: getFilterContributorQueryKey(filterId),
		queryFn: () => trpc.filters.getFilterContributors.query(filterId),
	})
}

const filterEntities = new Map<string, M.FilterEntity>()

export const filterMutation$ = new Rx.Observable<M.UserEntityMutation<M.FilterEntityId, M.FilterEntity>>((s) => {
	const sub = trpc.filters.watchFilters.subscribe(undefined, {
		onData: (_output) => {
			const output = PartsSys.stripParts(_output) as WatchFiltersOutput
			switch (output.code) {
				case 'initial-value': {
					filterEntities.clear()
					for (const entity of output.entities) {
						filterEntities.set(entity.id, entity)
					}
					break
				}
				case 'mutation': {
					switch (output.mutation.type) {
						case 'update':
							filterEntities.set(output.mutation.key, output.mutation.value)
							break
						case 'delete':
							filterEntities.delete(output.mutation.key)
							break
						case 'add':
							filterEntities.set(output.mutation.key, output.mutation.value)
							break
						default:
							assertNever(output.mutation.type)
					}
					s.next(output.mutation)
					break
				}
				default:
					assertNever(output)
			}
		},
		onComplete: () => s.complete(),
		onError: (e) => s.error(e),
	})
	return () => sub.unsubscribe()
}).pipe(Rx.share())

export function setup() {
	filterMutation$.subscribe()
	filterEntities$.subscribe()
}

export const [useFilterEntities, filterEntities$] = ReactRx.bind(
	filterMutation$.pipe(
		Rx.map(() => filterEntities),
	),
	filterEntities,
)

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
