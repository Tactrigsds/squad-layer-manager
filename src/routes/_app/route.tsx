import { createFileRoute, Outlet, useMatch } from '@tanstack/react-router'
import React from 'react'

import DesktopOnly from '@/components/desktop-only'
import NavBar from '@/components/nav-bar'
import { useIsSmallViewport } from '@/lib/browser'
import { orUndef } from '@/lib/types'
import { cn } from '@/lib/utils'
import * as ConfigClient from '@/systems/config.client'
import * as LayerQueriesClient from '@/systems/layer-queries.client'
import * as SettingsClient from '@/systems/settings.client'

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
	const isOnServers = useMatch({ from: '/_app/servers/', shouldThrow: false })
	const isPhone = useIsSmallViewport()
	// the phone layout covers the dashboard; every other page opens as the desktop page, by choice
	const desktopOnly = isPhone && !isOnServerDashboard && !isOnServers
	return (
		<div
			className="data-on-dashboard:h-screen w-full flex flex-col data-on-dashboard:overflow-hidden data-phone:h-screen data-phone:overflow-hidden"
			data-on-dashboard={orUndef(!!isOnServerDashboard)}
			data-phone={orUndef(isPhone)}
		>
			<NavBar />
			<div className={cn('flex flex-1 min-h-0 overflow-hidden', isPhone ? 'p-2' : 'p-2.5')}>
				{desktopOnly ? <DesktopOnly /> : <Outlet />}
			</div>
		</div>
	)
}
