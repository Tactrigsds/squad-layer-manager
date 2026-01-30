import { LayerInfo } from '@/components/layer-info'
import * as DH from '@/lib/display-helpers.ts'
import * as L from '@/models/layer'
import { createFileRoute, notFound, redirect } from '@tanstack/react-router'
import * as React from 'react'

export const Route = createFileRoute('/layers/$layerId/$tab')({
	component: RouteComponent,
	beforeLoad: ({ params }) => {
		if (L.parseLayerId(params.layerId).code === 'ok') {
			throw redirect({ to: '.', params: prev => ({ ...prev, layerId: L.getLayerCommand(params.layerId, 'none') }) })
		}
		const layer = L.parseRawLayerText(params.layerId)
		if (!layer || L.isRawLayerId(layer.id)) throw notFound()
		let tab: 'details' | 'scores'
		if (params.tab === 'scores') {
			tab = 'scores'
		} else if (params.tab === 'details') {
			tab = 'details'
		} else {
			throw notFound()
		}
		return { layer, tab }
	},
	head: ({ match }) => ({
		meta: [
			{ title: DH.displayLayer(match.context.layer) + ' - SLM' },
		],
	}),
	caseSensitive: true,
	shouldReload: true,
})

function RouteComponent() {
	const { layer, tab } = Route.useRouteContext()
	const navigate = Route.useNavigate()
	const setTab = (newTab: string) => {
		void navigate({
			to: '/layers/$layerId/$tab',
			params: { tab: newTab },
		})
	}
	return (
		<div className="w-screen h-screen p-4">
			<LayerInfo tab={tab} setTab={setTab} hidePopoutButton layerId={layer.id} />
		</div>
	)
}
