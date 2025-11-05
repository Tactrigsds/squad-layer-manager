import LayerQueueDashboard from '@/components/layer-queue-dashboard'
import { TabsList } from '@/components/ui/tabs-list'
import * as LayerTablePrt from '@/frame-partials/layer-table.partial'
import { frameManager, getFrameState } from '@/frames/frame-manager'
import * as SelectLayersFrame from '@/frames/select-layers.frame'
import { globalToast$ } from '@/hooks/use-global-toast'
import * as FRM from '@/lib/frame'
import * as Obj from '@/lib/object'
import * as LL from '@/models/layer-list.models'
import * as LQY from '@/models/layer-queries.models'
import * as PresenceActions from '@/models/shared-layer-list/presence-actions'
import * as RPC from '@/orpc.client'
import { rootRouter } from '@/root-router'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client'
import * as SLLClient from '@/systems.client/shared-layer-list.client'
import { useLoaderData, useLoaderDeps } from '@tanstack/react-router'
import { createFileRoute, redirect } from '@tanstack/react-router'
import { zodValidator } from '@tanstack/zod-adapter'
import React from 'react'
import { z } from 'zod'

const SearchParamsSchema = z.object({
	addLayers: z.object({
		itemId: LL.ItemIdSchema.optional(),
		placement: z.enum(['before', 'after']).default('before'),
		mode: z.enum(['before-or-after', 'fixed']),
	}).optional(),
})
type SearchParams = z.infer<typeof SearchParamsSchema>
export const Route = createFileRoute('/_app/servers/$serverId')({
	component: RouteComponent,
	validateSearch: zodValidator(SearchParamsSchema),
	loaderDeps: ({ search }) => search,
	onLeave: ({ loaderData, search }) => {
		SLLClient.Store.getState().pushPresenceAction(PresenceActions.endActivity({ code: 'adding-item' }))
		const data = loaderData as unknown as { frames: SelectLayersFrame.KeyProp } | undefined
		if (!data) return
		if (search.addLayers) {
			// this should happen automatically once the key is GCed, but just to be safe
			frameManager.teardown(data.frames.selectLayers)
		}
	},
	onStay(match) {
		const data = match.loaderData as unknown as { frames: SelectLayersFrame.KeyProp }
		if (match.loaderDeps.addLayers) {
			const state = getFrameState(data.frames.selectLayers)
			const cursor = resolveCursor(match.search)
			state.setCursor(cursor)
			SLLClient.Store.getState().pushPresenceAction(PresenceActions.startActivity({ code: 'adding-item' }))
		} else {
			SLLClient.Store.getState().pushPresenceAction(PresenceActions.endActivity({ code: 'adding-item' }))
		}
	},
	onEnter(match) {
		const data = match.loaderData as unknown as { frames: SelectLayersFrame.KeyProp }
		if (match.loaderDeps.addLayers) {
			const state = getFrameState(data.frames.selectLayers)
			const cursor = resolveCursor(match.loaderDeps)
			state.setCursor(cursor)
			SLLClient.Store.getState().pushPresenceAction(PresenceActions.startActivity({ code: 'adding-item' }))
		}
	},
	async loader({ deps, preload }): Promise<{ frames: SelectLayersFrame.KeyProp }> {
		const cursor = resolveCursor(deps)
		const input = SelectLayersFrame.createInput({ cursor, sharedInstanceId: 'ADD_LAYERS' })
		const frameKey = frameManager.ensureSetup(SelectLayersFrame.frame, input)

		const state = getFrameState(frameKey)

		// prefetch the query expected to fire once the page actually loads
		const queryInput = LayerTablePrt.selectQueryInput({
			...state,
			baseQueryInput: { ...(state.baseQueryInput ?? {}), cursor },
		})
		RPC.queryClient.prefetchQuery(LayerQueriesClient.getQueryLayersOptions(queryInput))
		if (!preload) {
			state.setCursor(cursor)
			SLLClient.Store.getState().pushPresenceAction(PresenceActions.startActivity({ code: 'adding-item' }))
		}
		return {
			frames: FRM.toProp(frameKey),
		}
	},
})

function RouteComponent() {
	return <LayerQueueDashboard />
}

function resolveCursor(search: SearchParams) {
	if (!search.addLayers) return
	const opts = search.addLayers
	const list = SLLClient.Store.getState().layerList
	let item: LL.Item | undefined
	if (opts.itemId) {
		item = LL.findItemById(list, opts.itemId)?.item
	}
	let cursor: LQY.Cursor

	if (!item) {
		if (opts.placement === 'before') {
			cursor = LQY.getQueryCursorForQueueIndex(0)
		} else {
			cursor = LQY.getQueryCursorForQueueIndex(list.length)
		}
	} else {
		const layerItem = LQY.getLayerItemForLayerListItem(item)
		cursor = LQY.getQueryCursorForLayerItem(layerItem, opts.placement === 'before' ? 'add-after' : 'edit')
	}
	return cursor
}
