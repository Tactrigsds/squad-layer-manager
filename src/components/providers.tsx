import { Toaster } from '@/components/ui/toaster'
import { transformer } from '@/lib/trpc'
import { trpc } from '@/lib/trpc.client.ts'
import { DndContext } from '@dnd-kit/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createWSClient, wsLink } from '@trpc/client'
import * as jotai from 'jotai'
import { ReactNode } from 'react'
import { useState } from 'react'

import { ThemeProvider } from './theme-provider'

export default function Providers(props: { children: ReactNode }) {
	const [queryClient] = useState(() => new QueryClient())
	const wsHostname = window.location.origin.replace(/^http/, 'ws')
	console.log('wsHostname', wsHostname)
	const [trpcClient] = useState(() =>
		trpc.createClient({
			links: [
				wsLink({
					client: createWSClient({ url: `ws://localhost:5173/trpc` }),
					transformer,
				}),
			],
		})
	)
	return (
		<trpc.Provider client={trpcClient} queryClient={queryClient}>
			<QueryClientProvider client={queryClient}>
				<jotai.Provider>
					<ThemeProvider defaultTheme="dark" storageKey="vite-ui-theme">
						{props.children}
						<Toaster />
					</ThemeProvider>
				</jotai.Provider>
			</QueryClientProvider>
		</trpc.Provider>
	)
}
