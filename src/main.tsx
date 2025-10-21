import * as DH from '@/lib/display-helpers.ts'
import * as AppRoutesClient from '@/systems.client/app-routes.client.ts'
import * as VotesClient from '@/systems.client/votes.client.ts'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import * as AR from './app-routes.ts'
import { Providers } from './components/providers.tsx'
import './index.css'
import { LayerInfoPage } from '@/components/layer-info'
import * as ConfigClient from '@/systems.client/config.client.ts'
import * as FilterEntityClient from '@/systems.client/filter-entity.client.ts'
import * as LayerQueriesClient from '@/systems.client/layer-queries.client.ts'
import * as MatchHistoryClient from '@/systems.client/match-history.client.ts'
import * as QueueDashboard from '@/systems.client/queue-dashboard'
import * as SharedLayerListClient from '@/systems.client/shared-layer-list.client.ts'
import * as SquadServerClient from '@/systems.client/squad-server.client'
import * as ThemeSys from '@/systems.client/theme.ts'
import * as UsersClient from '@/systems.client/users.client.ts'
import { enableMapSet } from 'immer'
import * as Rx from 'rxjs'
import AppContainer from './components/app-container.tsx'
import FilterEdit from './components/filter-edit.tsx'
import FilterIndex from './components/filter-index.tsx'
import FilterNew from './components/filter-new.tsx'
import FullPageSpinner from './components/full-page-spinner.tsx'
import LayerQueueDashboard from './components/layer-queue-dashboard.tsx'
import { formatVersion as formatAppVersion } from './lib/versioning.ts'

// Enable Map and Set support in Immer
enableMapSet()
console.log(`%cSLM version ${formatAppVersion(import.meta.env.PUBLIC_GIT_BRANCH, import.meta.env.PUBLIC_GIT_SHA)}`, 'color: limegreen')

const router = createBrowserRouter([
	{
		path: AR.route('/'),
		element: <Navigate to={AR.link('/servers/:id', AppRoutesClient.getCookie('default-server-id')!)} />,
	},
	{
		path: AR.route('/servers/:id'),
		element: (
			<React.Suspense fallback={<FullPageSpinner />}>
				<AppContainer>
					<LayerQueueDashboard />
				</AppContainer>
			</React.Suspense>
		),
	},

	// -------- filters ---------
	{
		path: AR.route('/filters'),
		element: (
			<React.Suspense fallback={<FullPageSpinner />}>
				<AppContainer>
					<FilterIndex />
				</AppContainer>
			</React.Suspense>
		),
	},
	{
		path: AR.route('/filters/:id'),
		element: (
			<React.Suspense fallback={<FullPageSpinner />}>
				<AppContainer>
					<FilterEdit />
				</AppContainer>
			</React.Suspense>
		),
	},
	{
		path: AR.route('/filters/new'),
		element: (
			<React.Suspense fallback={<FullPageSpinner />}>
				<AppContainer>
					<FilterNew />
				</AppContainer>
			</React.Suspense>
		),
	},

	// -------- Layer Info --------
	{
		path: AR.route('/layers/:id'),
		element: (
			<React.Suspense fallback={<FullPageSpinner />}>
				<LayerInfoPage />
			</React.Suspense>
		),
	},
])

console.log('running system initialization')

// -------- system initialization --------
ThemeSys.setup()
ConfigClient.setup()
FilterEntityClient.setup()
MatchHistoryClient.setup()
SquadServerClient.setup()
UsersClient.setup()
SharedLayerListClient.setup()
QueueDashboard.setup()
VotesClient.setup()

const route = AR.resolveRoute(window.location.pathname)
if (route && route?.id !== '/layers/:id') {
	void LayerQueriesClient.ensureFullSetup()
}

AppRoutesClient.route$
	.pipe(Rx.startWith(AR.resolveRoute(window.location.pathname)))
	.subscribe(async (route) => {
		let title = 'Squad Layer Manager'
		console.log('route:', route?.id)
		switch (route?.id) {
			case undefined:
				break
			case '/filters': {
				title = 'SLM - Filters'
				break
			}
			case '/filters/new': {
				title = 'SLM - New Filter'
				break
			}
			case '/filters/:id': {
				const filterEntity = await Rx.firstValueFrom(
					FilterEntityClient.initializedFilterEntities$().pipe(Rx.map(entities => entities.get(route.params.id))),
				)
				if (!filterEntity) break
				title = `SLM - ${filterEntity.name}`
				break
			}
			case '/servers/:id': {
				const config = await ConfigClient.fetchConfig()
				const server = config.servers.find(server => server.id == route.params.id)
				if (!server) break
				title = `SLM - ${server.displayName}`
				break
			}
			case '/layers/:id': {
				const title = `SLM - ${DH.displayLayer(route.params.id)}`
				document.title = title
				break
			}
		}

		document.title = title
	})

createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<Providers>
			<RouterProvider router={router} />
		</Providers>
	</React.StrictMode>,
)
