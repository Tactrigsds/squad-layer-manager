import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'

import { Route, exists } from './appRoutes.ts'
import AppContainer from './components/app-container.tsx'
import LayerExplorer from './components/layer-explorer.tsx'
import LayerQueue from './components/layer-queue.tsx'
import Providers from './components/providers.tsx'
import './index.css'

const path = (path: Route<'server'>) => exists('client', path)
const router = createBrowserRouter([
	{
		path: path('/layers'),
		element: (
			<AppContainer>
				<LayerExplorer />
			</AppContainer>
		),
	},
	{
		path: path('/'),
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
