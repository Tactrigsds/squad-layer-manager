import * as FeatureFlags from '@/systems.client/feature-flags.ts'
import * as ServerSettingsClient from '@/systems.client/server-settings.client.ts'
import * as VotesClient from '@/systems.client/votes.client.ts'
import * as TSR from '@tanstack/react-router'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Providers } from './components/providers.tsx'
import './index.css'
import * as ConfigClient from '@/systems.client/config.client.ts'
import * as FilterEntityClient from '@/systems.client/filter-entity.client.ts'
import * as MatchHistoryClient from '@/systems.client/match-history.client.ts'
import * as QueueDashboard from '@/systems.client/queue-dashboard'
import * as SharedLayerListClient from '@/systems.client/shared-layer-list.client.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as ThemeSys from '@/systems.client/theme.ts'
import * as UsersClient from '@/systems.client/users.client.ts'
import { enableMapSet } from 'immer'
import { rootRouter } from './root-router.ts'

// Enable Map and Set support in Immer
enableMapSet()
;(function setupClientSystems() {
	console.log('running system initialization')
	ThemeSys.setup()
	ConfigClient.setup()
	FilterEntityClient.setup()
	MatchHistoryClient.setup()
	SquadServerClient.setup()
	UsersClient.setup()
	void SharedLayerListClient.setup()
	QueueDashboard.setup()
	VotesClient.setup()
	ServerSettingsClient.setup()
	console.debug('systems initialized')

	const loadConsoleOnStartup = import.meta.env.DEV || FeatureFlags.get('loadConsole')
	if (loadConsoleOnStartup) {
		void import('@/systems.client/console.client.ts')
	} else {
		const unsub = FeatureFlags.Store.subscribe((state) => {
			if (state.flags.loadConsole) {
				void import('@/systems.client/console.client.ts')
				unsub()
			}
		})
	}
})()

createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<Providers>
			<TSR.RouterProvider router={rootRouter} />
		</Providers>
	</React.StrictMode>,
)
