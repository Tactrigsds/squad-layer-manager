import * as FeatureFlags from '@/systems/feature-flags.client'
import * as ServerSettingsClient from '@/systems/server-settings.client'
import * as VotesClient from '@/systems/vote.client'
import * as TSR from '@tanstack/react-router'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Providers } from './components/providers.tsx'
import './index.css'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ConfigClient from '@/systems/config.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as MatchHistoryClient from '@/systems/match-history.client'
import * as QueueDashboard from '@/systems/queue-dashboard.client'
import * as SharedLayerListClient from '@/systems/shared-layer-list.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as ThemeSys from '@/systems/theme.client'
import * as UserPresenceClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'
import { enableMapSet } from 'immer'
import { rootRouter } from './root-router.ts'

// Enable Map and Set support in Immer
enableMapSet()
;(function setupClientSystems() {
	console.log('running system initialization')
	ThemeSys.setup()
	ConfigClient.setup()
	FilterEntityClient.setup()
	BattlemetricsClient.setup()
	MatchHistoryClient.setup()
	SquadServerClient.setup()
	UsersClient.setup()
	void SharedLayerListClient.setup()
	void UserPresenceClient.setup()
	QueueDashboard.setup()
	VotesClient.setup()
	ServerSettingsClient.setup()
	console.debug('systems initialized')

	const loadConsoleOnStartup = import.meta.env.DEV || FeatureFlags.get('loadConsole')
	if (loadConsoleOnStartup) {
		void import('@/systems/console.client')
	} else {
		const unsub = FeatureFlags.Store.subscribe((state) => {
			if (state.flags.loadConsole) {
				void import('@/systems/console.client')
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
