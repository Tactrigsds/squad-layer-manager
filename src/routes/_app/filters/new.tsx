import FilterNew from '@/components/filter-new'
import * as EditFrame from '@/frames/filter-editor.frame.ts'
import { frameManager } from '@/frames/frame-manager'
import * as EFB from '@/models/editable-filter-builders.ts'
import type * as F from '@/models/filter.models'
import * as ConfigClient from '@/systems/config.client'
import { createFileRoute } from '@tanstack/react-router'
import React from 'react'

const DEFAULT_FILTER: F.EditableFilterNode = EFB.all()

// editor frames minted by the loader; each run creates a fresh instance, swept when the route is left
let activeFrameKeys: EditFrame.Key[] = []

export const Route = createFileRoute('/_app/filters/new')({
	component: RouteComponent,
	staleTime: Infinity,
	preloadStaleTime: Infinity,
	onLeave: () => {
		if (activeFrameKeys.length === 0) return
		const keys = activeFrameKeys
		activeFrameKeys = []
		void requestIdleCallback(() => {
			for (const k of keys) frameManager.dropKey(k)
		})
	},
	loader: async () => {
		const colConfig = await ConfigClient.fetchEffectiveColConfig()
		const frameInput = EditFrame.createInput({ startingFilter: DEFAULT_FILTER, colConfig })
		const frameKey = frameManager.ensureSetup(EditFrame.frame, frameInput)
		activeFrameKeys.push(frameKey)
		// frameInput kept so the component can revive the frame when cached loaderData outlives it
		return { frameKey, frameInput }
	},
	head: () => ({
		meta: [
			{ title: `New Filter - SLM` },
		],
	}),
})

function RouteComponent() {
	const { frameKey, frameInput } = Route.useLoaderData()
	// the router can serve cached loaderData whose frame was dropped by a previous visit's onLeave; recreate it from
	// the loader's input (a fresh editor, matching leave semantics) and re-register it for the next sweep
	const liveFrameKey = React.useMemo(() => {
		if (frameManager.getInstance(frameKey)) return frameKey
		const revived = frameManager.ensureSetup(EditFrame.frame, frameInput)
		activeFrameKeys.push(revived)
		return revived
	}, [frameKey, frameInput])
	return <FilterNew stores={{ filterEditor: liveFrameKey }} />
}
