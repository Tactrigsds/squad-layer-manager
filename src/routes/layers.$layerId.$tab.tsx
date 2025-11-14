import { LayerInfo } from '@/components/layer-info'
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
		return { layerId: layer.id, tab }
	},
	caseSensitive: true,
	shouldReload: true,
})

function RouteComponent() {
	const { layerId, tab } = Route.useRouteContext()
	const navigate = Route.useNavigate()
	const setTab = (newTab: string) => {
		navigate({
			to: '/layers/$layerId/$tab',
			params: { tab: newTab },
		})
	}
	return (
		<div className="w-[100vw] h-[100vh] p-4">
			<LayerInfo tab={tab} setTab={setTab} hidePopoutButton={true} layerId={layerId} />
		</div>
	)
}
