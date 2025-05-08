import React from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { exists } from './app-routes.ts'
import AppContainer from './components/app-container.tsx'
import { InnerRouterProviders, Providers } from './components/providers.tsx'
import './index.css'
import * as FilterEntityClient from '@/systems.client/filter-entity.client.ts'
import * as MatchHistoryClient from '@/systems.client/match-history.client.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import { enableMapSet } from 'immer'
import FullPageSpinner from './components/full-page-spinner.tsx'
import { formatVersion as formatAppVersion } from './lib/versioning.ts'

const FilterIndex = React.lazy(() => import('./components/filter-index.tsx'))
const FilterEdit = React.lazy(() => import('./components/filter-edit.tsx'))
const FilterNew = React.lazy(() => import('./components/filter-new.tsx'))
const LayerQueueDashboard = React.lazy(() => import('./components/layer-queue-dashboard.tsx'))

// Enable Map and Set support in Immer
enableMapSet()
console.log(`%cversion ${formatAppVersion(import.meta.env.PUBLIC_GIT_BRANCH, import.meta.env.PUBLIC_GIT_SHA)}`, 'color: limegreen')

const router = createBrowserRouter([
	{
		path: exists('/filters'),
		element: (
			<InnerRouterProviders>
				<AppContainer>
					<React.Suspense fallback={<FullPageSpinner />}>
						<FilterIndex />
					</React.Suspense>
				</AppContainer>
			</InnerRouterProviders>
		),
	},
	{
		path: exists('/filters/:id'),
		element: (
			<InnerRouterProviders>
				<AppContainer>
					<React.Suspense fallback={<FullPageSpinner />}>
						<FilterEdit />
					</React.Suspense>
				</AppContainer>
			</InnerRouterProviders>
		),
	},
	{
		path: exists('/filters/new'),
		element: (
			<InnerRouterProviders>
				<AppContainer>
					<React.Suspense fallback={<FullPageSpinner />}>
						<FilterNew />
					</React.Suspense>
				</AppContainer>
			</InnerRouterProviders>
		),
	},
	{
		path: exists('/'),
		element: (
			<InnerRouterProviders>
				<AppContainer>
					<React.Suspense fallback={<FullPageSpinner />}>
						<LayerQueueDashboard />
					</React.Suspense>
				</AppContainer>
			</InnerRouterProviders>
		),
	},
])

// -------- global server state setup --------
FilterEntityClient.setup()
MatchHistoryClient.recentMatchHistory$.subscribe()
MatchHistoryClient.currentMatchDetails$().subscribe()
SquadServerClient.squadServerStatus$.subscribe()

createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<Providers>
			<RouterProvider router={router} />
		</Providers>
	</React.StrictMode>,
)
