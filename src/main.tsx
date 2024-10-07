import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'

import AppContainer from './components/app-container.tsx'
import LayerExplorer from './components/layer-explorer.tsx'
import LayerQueue from './components/layer-queue.tsx'
import Providers from './components/providers.tsx'
import './index.css'

const router = createBrowserRouter([
	{
		path: '/layers',
		element: (
			<AppContainer>
				<LayerExplorer />
			</AppContainer>
		),
	},
	{
		path: '/',
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
