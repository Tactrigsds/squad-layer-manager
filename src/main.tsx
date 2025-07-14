import * as QueueDashboard from '@/systems.client/queue-dashboard'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { route } from './app-routes.ts'
import AppContainer from './components/app-container.tsx'
import { InnerRouterProviders, Providers } from './components/providers.tsx'
import './index.css'
import * as ConfigClient from '@/systems.client/config.client.ts'
import * as FilterEntityClient from '@/systems.client/filter-entity.client.ts'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client.ts'
import * as MatchHistoryClient from '@/systems.client/match-history.client.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as ThemeSys from '@/systems.client/theme.system.ts'
import * as UsersClient from '@/systems.client/users.client.ts'
import { enableMapSet } from 'immer'
import FilterEdit from './components/filter-edit.tsx'
import FilterIndex from './components/filter-index.tsx'
import FilterNew from './components/filter-new.tsx'
import LayerQueueDashboard from './components/layer-queue-dashboard.tsx'
import { formatVersion as formatAppVersion } from './lib/versioning.ts'

// Enable Map and Set support in Immer
enableMapSet()
console.log(`%cSLM version ${formatAppVersion(import.meta.env.PUBLIC_GIT_BRANCH, import.meta.env.PUBLIC_GIT_SHA)}`, 'color: limegreen')

const router = createBrowserRouter([
	{
		path: route('/filters'),
		element: (
			<InnerRouterProviders>
				<AppContainer>
					<FilterIndex />
				</AppContainer>
			</InnerRouterProviders>
		),
	},
	{
		path: route('/filters/:id'),
		element: (
			<InnerRouterProviders>
				<AppContainer>
					<FilterEdit />
				</AppContainer>
			</InnerRouterProviders>
		),
	},
	{
		path: route('/filters/new'),
		element: (
			<InnerRouterProviders>
				<AppContainer>
					<FilterNew />
				</AppContainer>
			</InnerRouterProviders>
		),
	},
	{
		path: route('/'),
		element: (
			<InnerRouterProviders>
				<AppContainer>
					<LayerQueueDashboard />
				</AppContainer>
			</InnerRouterProviders>
		),
	},
])

console.log('running system initialization')

// -------- system initialization --------
ThemeSys.setup()
void LayerQueriesClient.ensureSetup()
FilterEntityClient.setup()
MatchHistoryClient.setup()
SquadServerClient.setup()
UsersClient.setup()
ConfigClient.setup()
QueueDashboard.setup()

createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<Providers>
			<RouterProvider router={router} />
		</Providers>
	</React.StrictMode>,
)
