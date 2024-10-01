import { Toaster } from '@/components/ui/toaster'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { httpBatchLink } from '@trpc/client'
import * as jotai from 'jotai'
import { useState } from 'react'

import { FilterCard } from './components/filter-card'
import LayerTable from './components/layer-table'
import { ThemeProvider } from './components/theme-provider'
import { trpc } from './lib/trpc'
import * as M from './models'

function App() {
	const [queryClient] = useState(() => new QueryClient())
	const [trpcClient] = useState(() =>
		trpc.createClient({
			links: [
				httpBatchLink({
					url: 'http://localhost:5173/trpc',
					// You can pass any HTTP headers you wish here
					// async headers() {
					// return { 'Content-Type': 'application/json' }
					// },
				}),
			],
		})
	)
	return (
		<trpc.Provider client={trpcClient} queryClient={queryClient}>
			<QueryClientProvider client={queryClient}>
				<jotai.Provider>
					<ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
						<Ui />
					</ThemeProvider>
				</jotai.Provider>
			</QueryClientProvider>
		</trpc.Provider>
	)
}

const defaultFilter: M.EditableFilterNode = {
	type: 'and',
	children: [
		{
			type: 'comp',
			comp: {
				column: 'Level',
				code: 'eq',
				value: 'AlBasrah',
			},
		},
		// {
		// 	type: 'comp',
		// 	comp: {
		// 		code: 'in',
		// 		column: 'Gamemode',
		// 		values: ['RAAS', 'AAS'],
		// 	},
		// },
	],
}

function Ui() {
	const [editableFilter, setEditableFilter] = useState(defaultFilter)
	const [lastValidFilter, setLastValidFilter] = useState<M.FilterNode | null>(defaultFilter as M.FilterNode)
	const [pageIndex, setPageIndex] = useState(0)
	const setAndValidateFilter = (cb: (f: M.EditableFilterNode) => M.EditableFilterNode) => {
		setEditableFilter((filter) => {
			const newFilter = cb(filter)
			if (newFilter.type === 'and' && newFilter.children.length === 0) {
				setLastValidFilter(null)
			} else if (M.isValidFilterNode(newFilter)) {
				setLastValidFilter(newFilter)
			} else {
				console.warn('invalid filter', newFilter)
			}
			return newFilter
		})
		setPageIndex(0)
	}

	return (
		<div className="container mx-auto py-10">
			<FilterCard filter={editableFilter} setFilter={setAndValidateFilter} />
			<LayerTable filter={lastValidFilter} pageIndex={pageIndex} setPageIndex={setPageIndex} />
			<Toaster />
		</div>
	)
}

export default App
