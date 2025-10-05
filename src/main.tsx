import * as DH from '@/lib/display-helpers.ts'
import * as AppRoutesClient from '@/systems.client/app-routes.client.ts'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom'
import * as AR from './app-routes.ts'
import { InnerRouterProviders, Providers } from './components/providers.tsx'
import './index.css'
import { LayerInfoPage } from '@/components/layer-info'
import * as ConfigClient from '@/systems.client/config.client.ts'
import * as ThemeSys from '@/systems.client/theme.ts'
import { enableMapSet } from 'immer'
import * as Rx from 'rxjs'

import FullPageSpinner from './components/full-page-spinner.tsx'
import { assertNever } from './lib/type-guards.ts'
import { formatVersion as formatAppVersion } from './lib/versioning.ts'

// Lazy load components
const AppContainer = React.lazy(() => import('./components/app-container.tsx'))
const FilterEdit = React.lazy(() => import('./components/filter-edit.tsx'))
const FilterIndex = React.lazy(() => import('./components/filter-index.tsx'))
const FilterNew = React.lazy(() => import('./components/filter-new.tsx'))
const LayerQueueDashboard = React.lazy(() => import('./components/layer-queue-dashboard.tsx'))

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
			<InnerRouterProviders>
				<React.Suspense fallback={<FullPageSpinner />}>
					<AppContainer>
						<LayerQueueDashboard />
					</AppContainer>
				</React.Suspense>
			</InnerRouterProviders>
		),
	},

	// -------- filters ---------
	{
		path: AR.route('/filters'),
		element: (
			<InnerRouterProviders>
				<React.Suspense fallback={<FullPageSpinner />}>
					<AppContainer>
						<FilterIndex />
					</AppContainer>
				</React.Suspense>
			</InnerRouterProviders>
		),
	},
	{
		path: AR.route('/filters/:id'),
		element: (
			<InnerRouterProviders>
				<React.Suspense fallback={<FullPageSpinner />}>
					<AppContainer>
						<FilterEdit />
					</AppContainer>
				</React.Suspense>
			</InnerRouterProviders>
		),
	},
	{
		path: AR.route('/filters/new'),
		element: (
			<InnerRouterProviders>
				<React.Suspense fallback={<FullPageSpinner />}>
					<AppContainer>
						<FilterNew />
					</AppContainer>
				</React.Suspense>
			</InnerRouterProviders>
		),
	},

	// -------- Layer Info --------
	{
		path: AR.route('/layers/:id'),
		element: <LayerInfoPage />,
	},
])

console.log('running system initialization')

// -------- system initialization --------
ThemeSys.setup()
ConfigClient.setup()

let setupState: 'all' | 'layer-info' | null = null
let setupPromise: Promise<void> | null = null
async function ensureSystemsSetup() {
	if (setupState == 'all') return await setupPromise
	const route = AR.resolveRoute(window.location.pathname)
	if (!route) {
		console.warn('No route found for path:', window.location.pathname)
		throw new Error('No configured route found for path ' + window.location.pathname)
	}
	if (AR.isRouteType(route.def, 'custom')) return
	setupPromise = null
	switch (route.id) {
		case '/':
		case '/servers/:id':
		case '/filters':
		case '/filters/:id':
		case '/filters/new': {
			console.debug('loading full app')
			// we only need these systems if we're loading the full app
			setupPromise = (async () => {
				const [
					LayerQueriesClient,
					FilterEntityClient,
					MatchHistoryClient,
					SquadServerClient,
					UsersClient,
					QueueDashboard,
				] = await Promise.all([
					import('@/systems.client/layer-queries.client.ts'),
					import('@/systems.client/filter-entity.client.ts'),
					import('@/systems.client/match-history.client.ts'),
					import('@/systems.client/squad-server.client'),
					import('@/systems.client/users.client.ts'),
					import('@/systems.client/queue-dashboard'),
				])

				void LayerQueriesClient.ensureFullSetup()
				FilterEntityClient.setup()
				MatchHistoryClient.setup()
				SquadServerClient.setup()
				UsersClient.setup()
				QueueDashboard.setup()

				AppRoutesClient.route$
					.pipe(Rx.startWith(AR.resolveRoute(window.location.pathname)))
					.subscribe(async (route) => {
						let title = 'Squad Layer Manager'
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
								const filterEntity = FilterEntityClient.useFilterEntities().get(route.params.id)
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
						}

						document.title = title
					})

				setupState = 'all'
			})()
			break
		}
		case '/layers/:id': {
			console.debug('only loading layer info systems')
			setupState = 'layer-info'
			const title = `SLM - ${DH.displayLayer(route.params.id)}`
			document.title = title
			break
		}
	}

	setupPromise ??= Promise.resolve()
	return await setupPromise
}

Rx.merge([
	Rx.fromEvent(window, 'popstate'),
	Rx.fromEvent(window, 'pushstate'),
	Rx.fromEvent(window, 'replacestate'),
	Rx.fromEvent(window, 'hashchange'),
]).pipe(Rx.mergeAll()).subscribe(() => {
	void ensureSystemsSetup()
})

await ensureSystemsSetup()

createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<Providers>
			<RouterProvider router={router} />
		</Providers>
	</React.StrictMode>,
)
