import { FilterEdit } from '@/components/filter-edit'
import * as EditFrame from '@/frames/filter-editor.frame.ts'
import { frameManager } from '@/frames/frame-manager'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards'
import * as F from '@/models/filter.models'
import * as RPC from '@/orpc.client'
import { rootRouter } from '@/root-router'
import * as ConfigClient from '@/systems/config.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as UsersClient from '@/systems/users.client'
import { createFileRoute } from '@tanstack/react-router'
import React from 'react'
import * as Rx from 'rxjs'

// editor frames minted by the loader, per filter id. Each loader run creates a fresh instance (and a post-save
// router.invalidate() re-runs the loader), so several can accumulate before the route is left; onLeave sweeps them.
const activeFrameKeys = new Map<string, EditFrame.Key[]>()

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
	// the match param is typed explicitly: letting it infer makes the route type (and thus loaderData) circular
	onLeave: (match: { params: { filterId: F.FilterEntityId } }) => {
		const keys = activeFrameKeys.get(match.params.filterId)
		if (!keys) return
		activeFrameKeys.delete(match.params.filterId)
		void requestIdleCallback(() => {
			for (const k of keys) frameManager.dropKey(k)
		})
	},
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
		activeFrameKeys.set(params.filterId, [...(activeFrameKeys.get(params.filterId) ?? []), frameKey])

		return {
			entity: filterEntity,
			frameKey,
			// kept so the component can revive the frame when cached loaderData outlives it (see useLiveFrameKey)
			frameInput,
			contributors: filterContributorsRes,
			owner: ownerRes.user,
		}
	},

	head: ({ loaderData }) => ({
		meta: [
			{ title: loaderData ? `SLM - ${loaderData.entity.name}` : undefined },
		],
	}),
})

// the router can serve cached loaderData whose frame was dropped by a previous visit's onLeave (staleTime/preload
// caching); when that happens, recreate the frame from the loader's input (a fresh editor, matching leave semantics)
// and re-register it for the next sweep
function useLiveFrameKey(
	filterId: F.FilterEntityId,
	frameKey: EditFrame.Key | undefined,
	frameInput: EditFrame.Types['input'] | undefined,
): EditFrame.Key | undefined {
	return React.useMemo(() => {
		if (!frameKey || !frameInput) return undefined
		if (frameManager.getInstance(frameKey)) return frameKey
		const revived = frameManager.ensureSetup(EditFrame.frame, frameInput)
		activeFrameKeys.set(filterId, [...(activeFrameKeys.get(filterId) ?? []), revived])
		return revived
	}, [filterId, frameKey, frameInput])
}

function RouteComponent() {
	const loaderData = Route.useLoaderData()
	const params = Route.useParams()
	const frameKey = useLiveFrameKey(params.filterId, loaderData?.frameKey, loaderData?.frameInput)

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
							toast(`Filter ${mutation.value.name} was updated by ${mutation.displayName}`)
							break
						}
						case 'delete': {
							if (mutation.username === loggedInUser?.username) return
							toast(`Filter ${mutation.value.name} was deleted by ${mutation.displayName}`)
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

	if (!loaderData || !frameKey) return <p>Something went wrong</p>
	return (
		<FilterEdit
			entity={loaderData.entity}
			contributors={loaderData.contributors}
			owner={loaderData.owner}
			stores={{ filterEditor: frameKey }}
		/>
	)
}
