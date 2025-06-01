import React from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { exists } from './app-routes.ts'
import AppContainer from './components/app-container.tsx'
import { InnerRouterProviders, Providers } from './components/providers.tsx'
import './index.css'
import * as ConfigClient from '@/systems.client/config.client.ts'
import * as FilterEntityClient from '@/systems.client/filter-entity.client.ts'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client.ts'
import * as MatchHistoryClient from '@/systems.client/match-history.client.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
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
		path: exists('/filters'),
		element: (
			<InnerRouterProviders>
				<AppContainer>
					<FilterIndex />
				</AppContainer>
			</InnerRouterProviders>
		),
	},
	{
		path: exists('/filters/:id'),
		element: (
			<InnerRouterProviders>
				<AppContainer>
					<FilterEdit />
				</AppContainer>
			</InnerRouterProviders>
		),
	},
	{
		path: exists('/filters/new'),
		element: (
			<InnerRouterProviders>
				<AppContainer>
					<FilterNew />
				</AppContainer>
			</InnerRouterProviders>
		),
	},
	{
		path: exists('/'),
		element: (
			<InnerRouterProviders>
				<AppContainer>
					<LayerQueueDashboard />
				</AppContainer>
			</InnerRouterProviders>
		),
	},
])

// -------- global server state setup --------
FilterEntityClient.setup()
MatchHistoryClient.recentMatchHistory$().subscribe()
MatchHistoryClient.currentMatchDetails$().subscribe()
SquadServerClient.squadServerStatus$.subscribe()
LayerQueriesClient.setup()
UsersClient.setup()
ConfigClient.setup()

createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<Providers>
			<RouterProvider router={router} />
		</Providers>
	</React.StrictMode>,
)
