import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'

import AppContainer from './components/app-container.tsx'
import FilterEditor from './components/filter-editor.tsx'
import LayerQueue from './components/layer-queue.tsx'
import Providers from './components/providers.tsx'
import './index.css'

const router = createBrowserRouter([
	{
		path: '/filters/edit',
		element: (
			<Providers>
				<AppContainer>
					<FilterEditor />
				</AppContainer>
			</Providers>
		),
	},
	{
		path: '/',
		element: (
			<Providers>
				<AppContainer>
					<LayerQueue />
				</AppContainer>
			</Providers>
		),
	},
])

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<RouterProvider router={router} />
	</StrictMode>
)
