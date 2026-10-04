import { useMutation } from '@tanstack/react-query'

import * as MapUtils from '@/lib/map-utils'
import * as ReactRx from '@/lib/react-rxjs'
import * as Rx from '@/lib/rxjs'
import { assertNever } from '@/lib/type-guards'
import * as Zus from '@/lib/zustand'
import * as AppEvents_Msgs from '@/messages/app-events.messages'
import type * as FR from '@/models/filter-references.models'
import type * as F from '@/models/filter.models'
import * as LQY from '@/models/layer-queries.models'
import type * as USR from '@/models/users.models'
import * as RPC from '@/orpc.client'
import * as ConfigClient from '@/systems/config.client'
import type { FilterEntityChange } from '@/systems/filter-entity.server'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import { tr } from '@/systems/messages.client'
import * as PartsSys from '@/systems/parts.client'
import * as PluginsClient from '@/systems/plugins.client'

export const getFilterContributorsBase = (filterId: string) =>
	RPC.orpc.filters.getFilterContributors.queryOptions({
		input: filterId,
	})

export const getAllFilterRoleContributorsBase = () =>
	RPC.orpc.filters.getAllFilterRoleContributors.queryOptions({
		input: undefined,
	})

export function invalidateQueriesForFilter(filterId: F.FilterEntityId) {
	void RPC.queryClient.invalidateQueries({ queryKey: getFilterContributorsBase(filterId).queryKey })
	void RPC.queryClient.invalidateQueries({ queryKey: getAllFilterRoleContributorsBase().queryKey })
}

export async function filterEditPrefetch(filterId?: string) {
	if (!filterId) return {}
	return {
		onMouseEnter: async () => {
			const entity = filterEntities.get(filterId)
			if (!entity) return
			const colConfig = await ConfigClient.fetchEffectiveColConfig()
			void RPC.queryClient.prefetchQuery(getFilterContributorsBase(filterId))
			const input = LayerQueriesClient.getQueryLayersInput(LQY.getEditFilterPageBaseInput(entity.filter), { cfg: colConfig })
			LayerQueriesClient.prefetchLayersQuery(input)
		},
	}
}

export const filterEntities = new Map<string, F.FilterEntity>()
export const filterEntityChanged$ = new Rx.Subject<void>()

const [initialized$, setInitialized] = ReactRx.createSignal<true>()

// `prev` is the entity as it was before the mutation, if this client had it
export const filterMutation$ = new Rx.Observable<F.FilterEntityMutation & { prev: F.FilterEntity | undefined }>((s) => {
	const promise = RPC.observe('filters.watchFilters', () => RPC.orpc.filters.watchFilters.call()).subscribe(
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
					const prev = filterEntities.get(output.mutation.key)
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
					s.next({ ...output.mutation, prev })
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

// where each filter is referenced, recomputed server-side whenever a filter or a server's pool config changes.
// Empty until the first message lands, which reads as "referenced by nothing" -- deletion is gated server-side
// regardless, so the worst an early read costs is a delete button that is briefly enabled.
export const [useFilterReferences, filterReferences$] = ReactRx.bindWithDefault(
	RPC.observe('filters.watchFilterReferences', () => RPC.orpc.filters.watchFilterReferences.call()),
	new Map<F.FilterEntityId, FR.Reference[]>() as FR.Index,
)

// A user owner's name comes from `user`, which the caller resolves: only it knows whether the user is already in hand.
export function useOwnerName(owner: F.FilterOwner, user: USR.User | undefined): string | undefined {
	const pluginName = Zus.useStore(PluginsClient.Store, (s) =>
		owner.type === 'plugin' ? s.plugins.find((p) => p.id === owner.pluginId)?.name : undefined,
	)
	switch (owner.type) {
		case 'slm-user':
			return user?.displayName
		case 'plugin':
			return pluginName ?? owner.pluginId
		case 'system':
			return tr.text(AppEvents_Msgs.systemActor())
		default:
			assertNever(owner)
	}
}

export function setup() {
	filterMutation$.subscribe()
	filterEntities$.subscribe()
	filterReferences$.subscribe()
	initializedFilterEntities$().pipe(ReactRx.retryHot()).subscribe()
}

export const [useFilterEntities, filterEntities$] = ReactRx.bindWithDefault(
	filterEntityChanged$.pipe(Rx.map(() => MapUtils.deepClone(filterEntities))),
	filterEntities,
)

export const [useInitializedFilterEntities, initializedFilterEntities$] = ReactRx.bind('filterEntity.initializedFilterEntities', () =>
	initialized$.pipe(Rx.map(() => filterEntities)),
)

export function useFilterCreate() {
	return useMutation(RPC.orpc.filters.createFilter.mutationOptions())
}

export function useFilterUpdate() {
	return useMutation(RPC.orpc.filters.updateFilter.mutationOptions())
}

export function useFilterDelete() {
	return useMutation(RPC.orpc.filters.deleteFilter.mutationOptions())
}
