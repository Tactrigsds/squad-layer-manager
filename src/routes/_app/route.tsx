import NavBar from '@/components/nav-bar'

import { frameManager } from '@/frames/frame-manager.ts'
import * as SelectLayersFrame from '@/frames/select-layers.frame.ts'
import * as SquadServerFrame from '@/frames/squad-server.frame'
import { orUndef } from '@/lib/types'

import * as ConfigClient from '@/systems/config.client'

import * as LayerQueriesClient from '@/systems/layer-queries.client'

import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'

import { createFileRoute, Outlet, useMatch } from '@tanstack/react-router'

import React from 'react'

const EXPLORE_LAYERS_FRAME_INSTANCE_ID = 'explore-layers'

export const Route = createFileRoute('/_app')({
	loader: async () => {
		void LayerQueriesClient.ensureFullSetup()
		await Promise.all([ConfigClient.fetchConfig(), SettingsClient.fetchSettings()])
		const selectedServerId = SquadServerClient.SelectedServerStore.getState().selectedServerId
		let serverFrameKey: SquadServerFrame.Key | undefined
		if (selectedServerId) {
			serverFrameKey = frameManager.ensureSetup(SquadServerFrame.frame, SquadServerFrame.createInput(selectedServerId))
		}
		const input = SelectLayersFrame.createInput({ sharedInstanceId: EXPLORE_LAYERS_FRAME_INSTANCE_ID, squadServer: serverFrameKey })
		const frameId = frameManager.ensureSetup(SelectLayersFrame.frame, input)
		return { stores: { exploreLayers: frameId } }
	},
	component: RouteComponent,
})

function RouteComponent() {
	// Check if we're on the server dashboard route
	const isOnServerDashboard = useMatch({ from: '/_app/servers/$serverId', shouldThrow: false })
	return (
		<div
			className="data-on-dashboard:h-screen w-full flex flex-col data-on-dashboard:overflow-hidden"
			data-on-dashboard={orUndef(!!isOnServerDashboard)}
		>
			<NavBar />
			<div className="flex flex-1 min-h-0 p-4 overflow-hidden">
				<Outlet />
			</div>
		</div>
	)
}
