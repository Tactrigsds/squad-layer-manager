import * as AR from '@/appRoutes'
import { Toaster } from '@/components/ui/toaster'
import { transformer } from '@/lib/trpc'
import { trpc } from '@/lib/trpc.client.ts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createWSClient, wsLink } from '@trpc/client'
import * as jotai from 'jotai'
import { ReactNode } from 'react'
import { useState } from 'react'

import { ThemeProvider } from './theme-provider'

const wsHostname = window.location.origin.replace(/^http/, 'ws').replace(/\/$/, '')
const wsUrl = `${wsHostname}${AR.exists('/trpc')}`
export default function Providers(props: { children: ReactNode }) {
	const [queryClient] = useState(() => new QueryClient())
	const [trpcClient] = useState(() =>
		trpc.createClient({
			links: [
				wsLink({
					client: createWSClient({ url: wsUrl }),
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
