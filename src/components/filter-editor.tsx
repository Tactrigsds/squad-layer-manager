import { Toaster } from '@/components/ui/toaster'
import { trpc } from '@/lib/trpc'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { httpBatchLink } from '@trpc/client'
import * as jotai from 'jotai'
import { useState } from 'react'

import { FilterCard } from './filter-card'
import LayerTable from './layer-table'
import { ThemeProvider } from './theme-provider'

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

function Ui() {
	return (
		<div className="container mx-auto py-10">
			<FilterCard />
			<LayerTable />
			<Toaster />
		</div>
	)
}

export default App
