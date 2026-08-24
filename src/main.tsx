import './index.css'

import * as TSR from '@tanstack/react-router'
import { enableMapSet } from 'immer'
import React from 'react'
import { createRoot } from 'react-dom/client'

import * as Catalogues from '@/messages/catalogues'
import * as BattlemetricsClient from '@/systems/battlemetrics.client'
import * as ConfigClient from '@/systems/config.client'
import * as FeatureFlags from '@/systems/feature-flags.client'
import * as FilterEntityClient from '@/systems/filter-entity.client'
import * as LayerDataClient from '@/systems/layer-data.client'
import * as MessagesClient from '@/systems/messages.client'
import * as PluginsClient from '@/systems/plugins.client'
import * as SettingsClient from '@/systems/settings.client'
import * as SquadServerClient from '@/systems/squad-server.client'
import * as ThemeSys from '@/systems/theme.client'
import * as UserPresenceClient from '@/systems/user-presence.client'
import * as UsersClient from '@/systems/users.client'

import { INSTALLED_PLUGIN_CLIENTS } from '../plugins/index.ts'
import { Providers } from './components/providers.tsx'
import { rootRouter } from './root-router.ts'

// Enable Map and Set support in Immer
enableMapSet()

// components/factionunit configs are read synchronously throughout the component tree, so nothing
// can render before they're loaded
await LayerDataClient.setup()
;(function setupClientSystems() {
	console.debug('running system initialization')
	// catalogues first: the locale store negotiates against what is registered
	Catalogues.register()
	// one viewer per tab, so the locale is ambient; this reads their stored choice and falls back to the browser
	MessagesClient.setup()
	ThemeSys.setup()
	ConfigClient.setup()
	SquadServerClient.setup()
	SettingsClient.setup()
	FilterEntityClient.setup()
	BattlemetricsClient.setup()
	UsersClient.setup()
	void UserPresenceClient.setup()
	PluginsClient.setup(INSTALLED_PLUGIN_CLIENTS)
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
