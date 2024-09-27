import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { httpBatchLink } from '@trpc/client'
import { useEffect, useState } from 'react'

import LayerTable from './components/LayerTable'
import { ThemeProvider } from './components/theme-provider'
import { trpc } from './lib/trpc'

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
				<ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
					<Ui />
				</ThemeProvider>
			</QueryClientProvider>
		</trpc.Provider>
	)
}

function Ui() {
	return (
		<div className="container mx-auto py-10">
			<LayerTable />
		</div>
	)
}

export default App
