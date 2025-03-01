import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'

import React from 'react'
import { exists } from './app-routes.ts'
import AppContainer from './components/app-container.tsx'
import { InnerRouterProviders, Providers } from './components/providers.tsx'
import './index.css'
import { enableMapSet } from 'immer'

import FullPageSpinner from './components/full-page-spinner.tsx'
import { formatVersion as formatAppVersion } from './lib/versioning.ts'

// eslint-disable-next-line react-refresh/only-export-components
const FilterIndex = React.lazy(() => import('./components/filter-index.tsx'))
// eslint-disable-next-line react-refresh/only-export-components
const FilterEdit = React.lazy(() => import('./components/filter-edit.tsx'))
// eslint-disable-next-line react-refresh/only-export-components
const FilterNew = React.lazy(() => import('./components/filter-new.tsx'))
// eslint-disable-next-line react-refresh/only-export-components
const LayerQueue = React.lazy(() => import('./components/layer-queue.tsx'))

// Enable Map and Set support in Immer
enableMapSet()
console.log(`%cversion ${formatAppVersion(import.meta.env.PUBLIC_GIT_BRANCH, import.meta.env.PUBLIC_GIT_SHA)}`, 'color: lightgreen')

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
						<LayerQueue />
					</React.Suspense>
				</AppContainer>
			</InnerRouterProviders>
		),
	},
])

createRoot(document.getElementById('root')!).render(
	<React.StrictMode>
		<Providers>
			<RouterProvider router={router} />
		</Providers>
	</React.StrictMode>,
)
