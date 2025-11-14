import { FilterEdit } from '@/components/filter-edit'
import * as EditFrame from '@/frames/filter-editor.frame.ts'
import { frameManager } from '@/frames/frame-manager'
import { globalToast$ } from '@/hooks/use-global-toast'
import { withAbortSignal } from '@/lib/async'
import { assertNever } from '@/lib/type-guards'
import * as F from '@/models/filter.models'
import * as RPC from '@/orpc.client'
import { rootRouter } from '@/root-router'
import * as FilterEntityClient from '@/systems.client/filter-entity.client'
import * as UsersClient from '@/systems.client/users.client'
import { createFileRoute, useParams } from '@tanstack/react-router'
import * as Rx from 'rxjs'
import { z } from 'zod'

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
	loader: async ({ params, preload }) => {
		const filterContributorsRes = await RPC.queryClient.fetchQuery(FilterEntityClient.getFilterContributorsBase(params.filterId))
		const filterEntities = await Rx.firstValueFrom(FilterEntityClient.initializedFilterEntities$())
		const filterEntity = filterEntities.get(params.filterId)
		if (!filterEntity) return null
		const ownerRes = await RPC.queryClient.fetchQuery(UsersClient.getFetchUserOptions(filterEntity.owner))
		if (ownerRes.code !== 'ok') return null
		const frameInput = EditFrame.createInput({ editedFilterId: params.filterId, startingFilter: filterEntity.filter })
		const frameKey = frameManager.ensureSetup(EditFrame.frame, frameInput)
		console.log('loaded', params.filterId, { ...frameInput.sort, preload })

		return {
			entity: filterEntity,
			frameKey,
			contributors: filterContributorsRes,
			owner: ownerRes.user,
		}
	},
	onEnter: async ({ params, abortController }) => {
		const loggedInUser = await UsersClient.fetchLoggedInUser()
		FilterEntityClient.filterMutation$.pipe(
			withAbortSignal(abortController.signal),
		)
			.subscribe((mutation) => {
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
						rootRouter.navigate({ to: '/filters' })
						break
					}
					default:
						assertNever(mutation.type)
				}
				return () => sub.unsubscribe()
			})
	},
})

function RouteComponent() {
	const loaderData = Route.useLoaderData()
	if (!loaderData) return <p>Something went wrong</p>
	return <FilterEdit {...loaderData} />
}
