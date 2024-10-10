import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'

import { exists } from './app-routes.ts'
import AppContainer from './components/app-container.tsx'
import FilterEdit from './components/filter-edit.tsx'
import FilterIndex from './components/filter-index.tsx'
import FilterNew from './components/filter-new.tsx'
import LayerQueue from './components/layer-queue.tsx'
import Providers from './components/providers.tsx'
import './index.css'

const router = createBrowserRouter([
	{
		path: exists('/filters'),
		element: (
			<AppContainer>
				<FilterIndex />
			</AppContainer>
		),
	},
	{
		path: exists('/filters/:id/edit'),
		element: (
			<AppContainer>
				<FilterEdit />
			</AppContainer>
		),
	},
	{
		path: exists('/filters/new'),
		element: (
			<AppContainer>
				<FilterNew />
			</AppContainer>
		),
	},
	{
		path: exists('/'),
		element: (
			<AppContainer>
				<LayerQueue />
			</AppContainer>
		),
	},
])

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<Providers>
			<RouterProvider router={router} />
		</Providers>
	</StrictMode>
)
