import * as MapUtils from '@/lib/map'
import { assertNever } from '@/lib/type-guards'
import * as F from '@/models/filter.models'
import * as USR from '@/models/users.models'
import { type FilterEntityChange } from '@/server/systems/filter-entity'
import * as PartsSys from '@/systems.client/parts'
import { trpc } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import { createSignal } from '@react-rxjs/utils'
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

export const filterEntities = new Map<string, F.FilterEntity>()
export const filterEntityChanged$ = new Rx.Subject<void>()

const [initialized$, setInitialized] = createSignal<true>()

export const filterMutation$ = new Rx.Observable<USR.UserEntityMutation<F.FilterEntityId, F.FilterEntity>>((s) => {
	const sub = trpc.filters.watchFilters.subscribe(undefined, {
		onData: (_output) => {
			const output = PartsSys.stripParts(_output) as FilterEntityChange
			switch (output.code) {
				case 'initial-value': {
					filterEntities.clear()
					for (const entity of output.entities) {
						filterEntities.set(entity.id, entity)
					}
					setInitialized(true)
					break
				}
				case 'mutation': {
					switch (output.mutation.type) {
						case 'update':
						case 'add':
							filterEntities.set(output.mutation.key, output.mutation.value)
							break
						case 'delete':
							filterEntities.delete(output.mutation.key)
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
			filterEntityChanged$.next()
		},
		onComplete: () => s.complete(),
		onError: (e) => s.error(e),
	})
	return () => sub.unsubscribe()
}).pipe(Rx.share())

export function setup() {
	filterMutation$.subscribe()
	filterEntities$.subscribe()
	initializedFilterEntities$().subscribe()
}

export const [useFilterEntities, filterEntities$] = ReactRx.bind(
	filterEntityChanged$.pipe(Rx.map(() => MapUtils.deepClone(filterEntities))),
	filterEntities,
)

export const [useInitializedFilterEntities, initializedFilterEntities$] = ReactRx.bind(
	() => initialized$.pipe(Rx.map(() => filterEntities)),
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
