import NavBar from '@/components/nav-bar'

import { orUndef } from '@/lib/types'

import * as ConfigClient from '@/systems/config.client'

import * as LayerQueriesClient from '@/systems/layer-queries.client'

import * as SettingsClient from '@/systems/settings.client'

import { createFileRoute, Outlet, useMatch } from '@tanstack/react-router'

import React from 'react'

export const Route = createFileRoute('/_app')({
	loader: async () => {
		void LayerQueriesClient.ensureFullSetup()
		await Promise.all([ConfigClient.fetchConfig(), SettingsClient.fetchSettings()])
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
