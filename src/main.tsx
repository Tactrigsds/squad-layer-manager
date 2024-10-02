import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider, createBrowserRouter } from 'react-router-dom'

import FilterEditor from './components/filter-editor.tsx'
import LayerQueue from './components/layer-queue.tsx'
import './index.css'

const router = createBrowserRouter([
	{
		path: '/filters/edit',
		element: <FilterEditor />,
	},
	{
		path: '/',
		element: <LayerQueue />,
	},
])

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<RouterProvider router={router} />
	</StrictMode>
)
