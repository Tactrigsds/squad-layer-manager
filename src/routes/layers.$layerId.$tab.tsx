import { createFileRoute, notFound, redirect } from '@tanstack/react-router'
import * as React from 'react'

import { LayerInfo } from '@/components/layer-info'
import * as APP_Msgs from '@/messages/app.messages'
import * as DH from '@/models/display-helpers.models'
import * as L from '@/models/layer.models'
import { tr } from '@/systems/messages.client'

export const Route = createFileRoute('/layers/$layerId/$tab')({
	component: RouteComponent,
	beforeLoad: ({ params }) => {
		// links written before the URL took the command form carry an old abbreviated id or canonical text
		const linked = params.layerId.includes(':') ? L.fromStoredLayerText(params.layerId) : undefined
		if (linked !== undefined) {
			throw redirect({ to: '.', params: (prev) => ({ ...prev, layerId: L.getLayerCommand(linked, 'none') }) })
		}
		const layer = L.parseRawLayerText(params.layerId)
		if (!layer || L.isRawLayer(layer)) throw notFound()
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
		meta: [{ title: tr.text(APP_Msgs.pageTitle(DH.displayLayer(match.context.layer))) }],
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
