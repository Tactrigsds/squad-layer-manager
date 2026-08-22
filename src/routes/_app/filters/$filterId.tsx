import { createFileRoute } from '@tanstack/react-router'
import React from 'react'

import { FilterEdit } from '@/components/filter-edit'
import * as EditFrame from '@/frames/filter-editor.frame.ts'
import { frameManager } from '@/frames/frame-manager'
import * as Rx from '@/lib/rxjs'
import { toast } from '@/lib/toast'
import { assertNever } from '@/lib/type-guards'
import * as APP_Msgs from '@/messages/app.messages'
import * as F_Msgs from '@/messages/filter.messages'
import * as F from '@/models/filter.models'
import * as RPC from '@/orpc.client'
import { rootRouter } from '@/root-router'
import * as ConfigClient from '@/systems/config.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import { tr } from '@/systems/messages.client'
import * as UPClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'

// editor frames minted by the loader, per filter id. Each loader run creates a fresh instance, so several can
// accumulate before the route is left; onLeave sweeps them.
const activeFrameKeys = new Map<string, EditFrame.Key[]>()

// A frame holds this filter's shared-draft subscription open, which is what keeps the session provisioned on
// the server -- so a speculative preload that is never visited has to be swept on its own. Entering the route
// cancels the sweep; onLeave takes over from there.
const PRELOAD_TTL = 60_000
const preloadSweeps = new Map<string, ReturnType<typeof setTimeout>>()

function cancelPreloadSweep(filterId: string) {
	const timer = preloadSweeps.get(filterId)
	if (timer === undefined) return
	clearTimeout(timer)
	preloadSweeps.delete(filterId)
}

function sweepFrameKeys(filterId: string) {
	const keys = activeFrameKeys.get(filterId)
	if (!keys) return
	activeFrameKeys.delete(filterId)
	void requestIdleCallback(() => {
		for (const k of keys) frameManager.dropKey(k)
	})
}

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
		UPClient.Actions.dispatch({ code: 'navigated-away' })
		cancelPreloadSweep(match.params.filterId)
		sweepFrameKeys(match.params.filterId)
	},
	loader: async ({ params, preload }) => {
		// the popover reads this query itself, so the result is not returned. Still awaited: letting it land
		// after first paint measurably worsened the filter editor's add-strip teardown race.
		await RPC.queryClient.prefetchQuery(FilterEntityClient.getFilterContributorsBase(params.filterId))
		const filterEntities = await Rx.firstValueFrom(FilterEntityClient.initializedFilterEntities$())
		const filterEntity = filterEntities.get(params.filterId)
		if (!filterEntity) return null
		const ownerRes = await RPC.queryClient.fetchQuery(UsersClient.userQueryOptions(filterEntity.owner))
		if (ownerRes.code !== 'ok') return null
		const colConfig = await ConfigClient.fetchEffectiveColConfig()
		const frameInput = EditFrame.createInput({ editedFilterId: params.filterId, startingFilter: filterEntity.filter, colConfig })
		const frameKey = frameManager.ensureSetup(EditFrame.frame, frameInput)
		activeFrameKeys.set(params.filterId, [...(activeFrameKeys.get(params.filterId) ?? []), frameKey])
		if (preload && !preloadSweeps.has(params.filterId)) {
			preloadSweeps.set(
				params.filterId,
				setTimeout(() => {
					preloadSweeps.delete(params.filterId)
					sweepFrameKeys(params.filterId)
				}, PRELOAD_TTL),
			)
		}

		return {
			entity: filterEntity,
			frameKey,
			// kept so the component can revive the frame when cached loaderData outlives it (see useLiveFrameKey)
			frameInput,
			owner: ownerRes.user,
		}
	},

	head: ({ loaderData }) => ({
		meta: [{ title: loaderData ? `SLM - ${loaderData.entity.name}` : undefined }],
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

	// the page was actually opened, so the preloaded frame is in use and its sweep no longer applies
	React.useEffect(() => {
		cancelPreloadSweep(params.filterId)
		UPClient.Actions.ensureOnFilter(params.filterId)
	}, [params.filterId])

	React.useEffect(() => {
		const sub = FilterEntityClient.filterMutation$.pipe().subscribe({
			next: async (mutation) => {
				const loggedInUser = await UsersClient.fetchLoggedInUser()
				if (!mutation || mutation.key !== params.filterId) return
				switch (mutation.type) {
					case 'add':
						break
					case 'update': {
						if (mutation.userId === loggedInUser?.discordId) return
						toast(...tr.toast(F_Msgs.updatedBy(mutation.value.name, await UsersClient.fetchDisplayName(mutation.userId))))
						break
					}
					case 'delete': {
						if (mutation.userId === loggedInUser?.discordId) return
						toast(...tr.toast(F_Msgs.deletedBy(mutation.value.name, await UsersClient.fetchDisplayName(mutation.userId))))
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

	if (!loaderData || !frameKey) return <p>{tr.text(APP_Msgs.somethingWentWrong())}</p>
	return (
		<FilterEdit
			// a reference badge navigates between filters on this same route, so without the key the editor UI
			// (form, tabs, codemirror) would survive the swap holding the previous filter's state
			key={params.filterId}
			entity={loaderData.entity}
			owner={loaderData.owner}
			stores={{ filterEditor: frameKey }}
		/>
	)
}
