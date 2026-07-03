import * as FeatureFlags from '@/systems/feature-flags.client'
import * as SettingsClient from '@/systems/settings.client'
import * as TSR from '@tanstack/react-router'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Providers } from './components/providers.tsx'
import './index.css'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ConfigClient from '@/systems/config.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as ThemeSys from '@/systems/theme.client'
import * as UserPresenceClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'
import { enableMapSet } from 'immer'
import { rootRouter } from './root-router.ts'

// Enable Map and Set support in Immer
enableMapSet()
;(function setupClientSystems() {
	console.debug('running system initialization')
	ThemeSys.setup()
	ConfigClient.setup()
	SquadServerClient.setup()
	SettingsClient.setup()
	FilterEntityClient.setup()
	BattlemetricsClient.setup()
	UsersClient.setup()
	void UserPresenceClient.setup()
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

console.log('mounting react root')

createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<Providers>
			<TSR.RouterProvider router={rootRouter} />
		</Providers>
	</React.StrictMode>,
)
