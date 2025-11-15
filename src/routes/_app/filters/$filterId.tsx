import { FilterEdit } from '@/components/filter-edit'
import * as EditFrame from '@/frames/filter-editor.frame.ts'
import { frameManager } from '@/frames/frame-manager'
import { globalToast$ } from '@/hooks/use-global-toast'
import { assertNever } from '@/lib/type-guards'
import * as F from '@/models/filter.models'
import * as RPC from '@/orpc.client'
import { rootRouter } from '@/root-router'
import * as ConfigClient from '@/systems.client/config.client'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import * as UsersClient from '@/systems.client/users.client'
import { createFileRoute } from '@tanstack/react-router'
import React from 'react'
import * as Rx from 'rxjs'

export const Route = createFileRoute('/_app/filters/$filterId')({
	component: RouteComponent,
	params: {
		parse: (params) => {
			return {
				filterId: F.FilterEntityIdSchema.parse(params.filterId),
			}
		},
	},
	staleTime: Infinity,
	preloadStaleTime: Infinity,
	loader: async ({ params }) => {
		const filterContributorsRes = await RPC.queryClient.fetchQuery(FilterEntityClient.getFilterContributorsBase(params.filterId))
		const filterEntities = await Rx.firstValueFrom(FilterEntityClient.initializedFilterEntities$())
		const filterEntity = filterEntities.get(params.filterId)
		if (!filterEntity) return null
		const ownerRes = await RPC.queryClient.fetchQuery(UsersClient.getFetchUserOptions(filterEntity.owner))
		if (ownerRes.code !== 'ok') return null
		const colConfig = await ConfigClient.fetchEffectiveColConfig()
		const frameInput = EditFrame.createInput({ editedFilterId: params.filterId, startingFilter: filterEntity.filter, colConfig })
		const frameKey = frameManager.ensureSetup(EditFrame.frame, frameInput)

		return {
			entity: filterEntity,
			frameKey,
			contributors: filterContributorsRes,
			owner: ownerRes.user,
		}
	},
})

function RouteComponent() {
	const loaderData = Route.useLoaderData()
	const params = Route.useParams()

	React.useEffect(() => {
		const sub = FilterEntityClient.filterMutation$.pipe()
			.subscribe({
				next: async (mutation) => {
					const loggedInUser = await UsersClient.fetchLoggedInUser()
					if (!mutation || mutation.key !== params.filterId) return
					switch (mutation.type) {
						case 'add':
							break
						case 'update': {
							if (mutation.username === loggedInUser?.username) return
							globalToast$.next({
								title: `Filter ${mutation.value.name} was updated by ${mutation.displayName}`,
							})
							break
						}
						case 'delete': {
							if (mutation.username === loggedInUser?.username) return
							globalToast$.next({
								title: `Filter ${mutation.value.name} was deleted by ${mutation.displayName}`,
							})
							void rootRouter.navigate({ to: '/filters' })
							break
						}
						default:
							assertNever(mutation.type)
					}
				},
			})
		return () => sub.unsubscribe()
	}, [params.filterId])

	if (!loaderData) return <p>Something went wrong</p>
	return <FilterEdit {...loaderData} />
}
