import { fromOrpcSubscription } from '@/lib/async'
import * as MapUtils from '@/lib/map'
import { assertNever } from '@/lib/type-guards'
import * as F from '@/models/filter.models'
import * as LQY from '@/models/layer-queries.models'
import * as USR from '@/models/users.models'
import { type FilterEntityChange } from '@/server/systems/filter-entity'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import * as PartsSys from '@/systems.client/parts'
import { orpc, orpcReact, reactQueryClient } from '@/trpc.client'
import * as ReactRx from '@react-rxjs/core'
import { createSignal } from '@react-rxjs/utils'
import { useMutation } from '@tanstack/react-query'
import * as Rx from 'rxjs'

export const getFilterContributorsBase = (filterId: string) =>
	orpcReact.filters.getFilterContributors.queryOptions({
		input: filterId,
	})

export const getAllFilterRoleContributorsBase = () =>
	orpcReact.filters.getAllFilterRoleContributors.queryOptions({
		input: undefined,
	})

export function invalidateQueriesForFilter(filterId: F.FilterEntityId) {
	reactQueryClient.invalidateQueries({ queryKey: getFilterContributorsBase(filterId).queryKey })
	reactQueryClient.invalidateQueries({ queryKey: getAllFilterRoleContributorsBase().queryKey })
}

export async function filterEditPrefetch(filterId?: string) {
	if (!filterId) return {}
	return {
		onMouseEnter() {
			const entity = filterEntities.get(filterId)
			if (!entity) return
			void reactQueryClient.prefetchQuery(getFilterContributorsBase(filterId))
			void LayerQueriesClient.prefetchLayersQuery(LQY.getEditFilterPageInput(entity.filter))
		},
	}
}

export function filterIndexPrefetch() {
	return {
		onMouseEnter() {
			void reactQueryClient.prefetchQuery(getAllFilterRoleContributorsBase())
		},
	}
}

export const filterEntities = new Map<string, F.FilterEntity>()
export const filterEntityChanged$ = new Rx.Subject<void>()

const [initialized$, setInitialized] = createSignal<true>()

export const filterMutation$ = new Rx.Observable<USR.UserEntityMutation<F.FilterEntityId, F.FilterEntity>>((s) => {
	const promise = fromOrpcSubscription(() => orpc.filters.watchFilters()).subscribe(
		(_output) => {
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
		(e) => s.error(e),
		() => s.complete(),
	)
	return () => promise.unsubscribe()
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
	return useMutation(orpcReact.filters.createFilter.mutationOptions())
}

export function useFilterUpdate() {
	return useMutation(orpcReact.filters.updateFilter.mutationOptions())
}

export function useFilterDelete() {
	return useMutation(orpcReact.filters.deleteFilter.mutationOptions())
}
