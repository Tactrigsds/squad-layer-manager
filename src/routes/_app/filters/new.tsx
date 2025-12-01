import FilterNew from '@/components/filter-new'
import * as EditFrame from '@/frames/filter-editor.frame.ts'
import { frameManager } from '@/frames/frame-manager'
import * as EFB from '@/models/editable-filter-builders.ts'
import type * as F from '@/models/filter.models'
import * as ConfigClient from '@/systems.client/config.client'
import { createFileRoute } from '@tanstack/react-router'

const DEFAULT_FILTER: F.EditableFilterNode = EFB.and()

export const Route = createFileRoute('/_app/filters/new')({
	component: RouteComponent,
	staleTime: Infinity,
	preloadStaleTime: Infinity,
	loader: async () => {
		const colConfig = await ConfigClient.fetchEffectiveColConfig()
		const frameInput = EditFrame.createInput({ startingFilter: DEFAULT_FILTER, colConfig })
		const frameKey = frameManager.ensureSetup(EditFrame.frame, frameInput)
		return { frameKey }
	},
	head: () => ({
		meta: [
			{ title: `New Filter - SLM` },
		],
	}),
})

function RouteComponent() {
	const { frameKey } = Route.useLoaderData()
	return <FilterNew frameKey={frameKey} />
}
